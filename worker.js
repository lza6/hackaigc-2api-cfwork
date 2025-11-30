/**
 * =================================================================================
 * 项目: HackAIGC-2API (v7.0 双模适配版)
 * 作者: 2API Project
 * 核心: Cloudflare Worker
 * 
 * [v7.0 核心逻辑]
 * 1. [Web UI 模式]: 前端 JS 智能判断。如果是 Midjourney，直接调用 /images/generations 接口。
 *    -> 结果: 浏览器直接渲染高清图片，无 Markdown 乱码。
 * 
 * 2. [API 客户端模式]: 后端路由智能拦截。如果 Cherry Studio 发送 Midjourney 到 /chat/completions。
 *    -> 结果: Worker 自动拦截，生成图片后封装为 Markdown 流式返回。
 * 
 * [修复] 解决了 Web UI 显示 raw json 数据的问题。
 * =================================================================================
 */

const CONFIG = {
  // 你的 API Key
  API_MASTER_KEY: "sk-hackaigc-free",
  
  // 上游地址
  UPSTREAM_URL: "https://chat.hackaigc.com",
  
  // 伪装 User-Agent
  USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",

  // 模型映射
  MODEL_MAP: {
    "gpt-4o": "gpt-4o",
    "o1-mini": "o3-mini",
    "claude-3-opus": "mistral",
    "midjourney": "midjourney" 
  }
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS 预检
    if (request.method === 'OPTIONS') return handleCors();

    // 2. Web UI (根路径)
    if (url.pathname === '/' || url.pathname === '/index.html') return handleWebUI(request, env);

    // 3. 鉴权
    if (!verifyAuth(request, env)) {
      return new Response(JSON.stringify({ error: { message: "Unauthorized", type: "auth_error" } }), { 
        status: 401, 
        headers: corsHeaders({ "Content-Type": "application/json" }) 
      });
    }

    // 4. 路由分发 (移除 /v1 前缀)
    const path = url.pathname.replace('/v1', '');

    // [关键路由]
    if (path.endsWith('/chat/completions')) return handleChat(request); // API 客户端主要走这里
    if (path.endsWith('/images/generations')) return handleImage(request); // Web UI 绘图走这里
    if (path.endsWith('/models')) return handleModels();

    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders() });
  }
};

// --- [业务 A: 聊天接口 (含 API 客户端的绘图拦截)] ---
async function handleChat(request) {
  try {
    const body = await request.json();
    let { messages, model, stream } = body;
    
    // ★★★ 拦截器: 专门为 Cherry Studio/NextChat 等客户端设计 ★★★
    // 如果客户端非要把 midjourney 发到聊天接口，我们在这里拦截并转为 Markdown 图片
    if (model.includes('midjourney')) {
        return handleImageAsChat(messages, stream);
    }

    // --- 常规聊天逻辑 ---
    const internalModel = CONFIG.MODEL_MAP[model] || "gpt-3.5-turbo";
    
    // 提取 Prompt
    const filteredMessages = messages.map(m => ({ role: m.role, content: m.content }));

    const guestId = generateGuestId();
    const headers = getFakeHeaders(guestId);

    const upstreamPayload = {
      user_id: guestId,
      user_level: "free",
      model: internalModel,
      messages: filteredMessages,
      prompt: "",
      temperature: body.temperature || 0.7,
      enableWebSearch: false,
      usedVoiceInput: false,
      deviceId: guestId
    };

    const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/chat`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(upstreamPayload)
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: `Upstream Error: ${response.status}`, details: errText }), { 
          status: response.status, 
          headers: corsHeaders({ "Content-Type": "application/json" }) 
      });
    }

    // 流式转发
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    (async () => {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunkText = decoder.decode(value, { stream: true });
          if (chunkText.includes('"type":"citations"')) continue;

          if (chunkText) {
            const chunk = {
              id: `chatcmpl-${Date.now()}`,
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: model,
              choices: [{
                index: 0,
                delta: { content: chunkText },
                finish_reason: null
              }]
            };
            await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        }
        await writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch (err) {
        await writer.write(encoder.encode(`data: {"error": "${err.message}"}\n\n`));
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: corsHeaders({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      })
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
  }
}

// --- [业务 B: 聊天转绘图 (API 客户端专用)] ---
// 将图片转换为 Markdown 格式流式返回，骗过 Cherry Studio
async function handleImageAsChat(messages, stream) {
    const lastUserMsg = messages.reverse().find(m => m.role === 'user');
    const prompt = lastUserMsg ? lastUserMsg.content : "A cute cat";

    try {
        const base64Image = await fetchImageBase64(prompt);
        const markdownContent = `🎨 **绘图完成**\n\n![Generated Image](data:image/png;base64,${base64Image})`;

        if (stream) {
            const encoder = new TextEncoder();
            const { readable, writable } = new TransformStream();
            const writer = writable.getWriter();

            (async () => {
                const chunk = {
                    id: `chatcmpl-${Date.now()}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: "midjourney",
                    choices: [{ index: 0, delta: { content: markdownContent }, finish_reason: "stop" }]
                };
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                await writer.write(encoder.encode("data: [DONE]\n\n"));
                await writer.close();
            })();

            return new Response(readable, {
                headers: corsHeaders({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache" })
            });
        } else {
            return new Response(JSON.stringify({
                id: `chatcmpl-${Date.now()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "midjourney",
                choices: [{ index: 0, message: { role: "assistant", content: markdownContent }, finish_reason: "stop" }]
            }), { headers: corsHeaders({ "Content-Type": "application/json" }) });
        }
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: corsHeaders() });
    }
}

// --- [业务 C: 标准绘图接口 (Web UI 专用)] ---
// 返回标准的 OpenAI Image 格式 (JSON + b64_json)
async function handleImage(request) {
  try {
    const body = await request.json();
    const prompt = body.prompt;
    
    const base64Image = await fetchImageBase64(prompt);

    const openAIResponse = {
      created: Math.floor(Date.now() / 1000),
      data: [{ b64_json: base64Image, revised_prompt: prompt }]
    };

    return new Response(JSON.stringify(openAIResponse), {
      headers: corsHeaders({ "Content-Type": "application/json" })
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: corsHeaders() });
  }
}

// --- [底层: 获取图片并转 Base64] ---
async function fetchImageBase64(prompt) {
    const guestId = generateGuestId();
    const headers = getFakeHeaders(guestId);

    const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/image`, {
      method: "POST",
      headers: { ...headers, "Accept": "image/png,image/jpeg,*/*" },
      body: JSON.stringify({
        prompt: prompt,
        user_id: guestId,
        device_id: guestId,
        user_level: "free"
      })
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Upstream Error (${response.status}): ${errText.substring(0, 100)}`);
    }

    const imageBuffer = await response.arrayBuffer();
    if (imageBuffer.byteLength === 0) throw new Error("Empty image received");
    
    return arrayBufferToBase64(imageBuffer);
}

// --- [辅助函数] ---
function handleModels() {
  const models = Object.keys(CONFIG.MODEL_MAP).map(id => ({
    id: id, object: "model", created: 1677610602, owned_by: "hackaigc"
  }));
  return new Response(JSON.stringify({ object: "list", data: models }), { headers: corsHeaders() });
}

function generateGuestId() {
  const randomHex = Array.from({length: 32}, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `guest_${randomHex}`;
}

function getFakeHeaders(guestId) {
  const ip = `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer anonymous_${guestId}`,
    "User-Agent": CONFIG.USER_AGENT,
    "Origin": CONFIG.UPSTREAM_URL,
    "Referer": `${CONFIG.UPSTREAM_URL}/`,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip
  };
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  const chunkSize = 0x8000; 
  for (let i = 0; i < len; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunkSize, len)));
  }
  return btoa(binary);
}

function verifyAuth(req, env) {
  const authHeader = req.headers.get("Authorization");
  const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
  if (!authHeader) return false;
  const token = authHeader.replace('Bearer ', '').trim();
  return token === apiKey;
}

function handleCors() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

function corsHeaders(headers = {}) {
  return {
    ...headers,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };
}

// --- [Web UI: 智能双模版] ---
function handleWebUI(request, env) {
  const apiKey = env.API_MASTER_KEY || CONFIG.API_MASTER_KEY;
  const origin = new URL(request.url).origin;
  
  const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>HackAIGC 驾驶舱 v7.0</title>
    <style>
        :root { --bg: #0f172a; --sidebar: #1e293b; --text: #e2e8f0; --accent: #3b82f6; }
        body { margin: 0; font-family: sans-serif; background: var(--bg); color: var(--text); height: 100vh; display: flex; }
        .container { display: flex; width: 100%; }
        .sidebar { width: 300px; background: var(--sidebar); padding: 20px; display: flex; flex-direction: column; }
        .main { flex: 1; display: flex; flex-direction: column; padding: 20px; }
        .chat-box { flex: 1; overflow-y: auto; margin-bottom: 20px; border: 1px solid #334155; border-radius: 8px; padding: 15px; }
        input, select, textarea { width: 100%; background: #334155; border: 1px solid #475569; color: white; padding: 10px; margin-bottom: 10px; border-radius: 4px; box-sizing: border-box;}
        button { width: 100%; background: var(--accent); color: white; border: none; padding: 10px; border-radius: 4px; cursor: pointer; }
        .msg { margin-bottom: 10px; padding: 10px; border-radius: 8px; max-width: 80%; word-wrap: break-word; }
        .msg.user { background: var(--accent); align-self: flex-end; margin-left: auto; }
        .msg.ai { background: #334155; align-self: flex-start; }
        img { max-width: 100%; border-radius: 8px; margin-top: 5px; display: block; }
    </style>
</head>
<body>
    <div class="container">
        <div class="sidebar">
            <h2>🚀 HackAIGC v7.0</h2>
            <label>API Key</label>
            <input type="text" value="${apiKey}" readonly onclick="this.select();document.execCommand('copy')">
            <label>Base URL</label>
            <input type="text" value="${origin}/v1" readonly>
            <label>模型</label>
            <select id="model">
                <option value="gpt-4o">GPT-4o</option>
                <option value="o1-mini">o3-mini</option>
                <option value="claude-3-opus">Mistral</option>
                <option value="midjourney">Midjourney (绘图)</option>
            </select>
            <div style="margin-top:auto; font-size:12px; color:#aaa">
                <p>状态: ✅ 双模就绪</p>
                <p>Web UI: 原生渲染</p>
                <p>API: 自动拦截适配</p>
            </div>
        </div>
        <div class="main">
            <div class="chat-box" id="chat-box">
                <div class="msg ai">你好！我是 HackAIGC 代理。<br>Web UI 已恢复原生绘图渲染，同时支持 Cherry Studio 等客户端。</div>
            </div>
            <textarea id="prompt" rows="3" placeholder="输入消息..."></textarea>
            <button id="sendBtn" onclick="send()">发送</button>
        </div>
    </div>
    <script>
        const API_KEY = "${apiKey}";
        const BASE_URL = "${origin}/v1";
        
        async function send() {
            const text = document.getElementById('prompt').value;
            const model = document.getElementById('model').value;
            const sendBtn = document.getElementById('sendBtn');
            if(!text) return;
            
            const chatBox = document.getElementById('chat-box');
            chatBox.innerHTML += \`<div class="msg user">\${text}</div>\`;
            document.getElementById('prompt').value = '';
            sendBtn.disabled = true;
            sendBtn.innerText = '处理中...';
            
            const aiDiv = document.createElement('div');
            aiDiv.className = 'msg ai';
            aiDiv.innerText = '...';
            chatBox.appendChild(aiDiv);
            chatBox.scrollTop = chatBox.scrollHeight;

            try {
                // ★★★ Web UI 专用逻辑: 如果是绘图，走 /images/generations ★★★
                if (model === 'midjourney') {
                    aiDiv.innerText = '🎨 正在请求 Midjourney 绘图 (约10-20秒)...';
                    
                    const res = await fetch(BASE_URL + '/images/generations', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
                        body: JSON.stringify({ prompt: text, model: 'midjourney' })
                    });
                    
                    const data = await res.json();
                    if (data.error) throw new Error(JSON.stringify(data.error));
                    
                    if (data.data && data.data[0] && data.data[0].b64_json) {
                        aiDiv.innerHTML = \`🎨 绘图成功:<br><img src="data:image/png;base64,\${data.data[0].b64_json}">\`;
                    } else {
                        throw new Error('未收到图片数据');
                    }
                } 
                // ★★★ 对话逻辑: 走 /chat/completions ★★★
                else {
                    const res = await fetch(BASE_URL + '/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
                        body: JSON.stringify({
                            model: model,
                            messages: [{role: 'user', content: text}],
                            stream: true
                        })
                    });

                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let fullText = '';
                    aiDiv.innerText = '';

                    while(true) {
                        const {done, value} = await reader.read();
                        if(done) break;
                        const chunk = decoder.decode(value, {stream: true});
                        const lines = chunk.split('\\n');
                        for(const line of lines) {
                            if(line.startsWith('data: ')) {
                                const jsonStr = line.slice(6);
                                if(jsonStr === '[DONE]') continue;
                                try {
                                    const json = JSON.parse(jsonStr);
                                    const content = json.choices[0]?.delta?.content || '';
                                    fullText += content;
                                    aiDiv.innerText = fullText;
                                    chatBox.scrollTop = chatBox.scrollHeight;
                                } catch(e){}
                            }
                        }
                    }
                }
            } catch(e) {
                aiDiv.innerText = '❌ Error: ' + e.message;
            } finally {
                sendBtn.disabled = false;
                sendBtn.innerText = '发送';
            }
        }
    </script>
</body>
</html>
  `;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
