import { getStatusPluginEndpointSource } from '../opencode/status-plugin-endpoint-source'

export const DSH_CONSOLE_STATUS_PLUGIN_FILE = 'orca-status/index.mjs'
export const DSH_CONSOLE_STATUS_PLUGIN_MARKER = 'Managed by Orca: DSH Console status bridge v1'

/** Loaded by published DSH via Cordis, without importing Orca or replacing the Console runner. */
export function getDshConsoleStatusPluginSource(): string {
  return `// ${DSH_CONSOLE_STATUS_PLUGIN_MARKER}
import { createRequire } from 'node:module';
import { request as httpRequest } from 'node:http';
const require = createRequire(import.meta.url);
// Shared with OpenCode; references to its process below mean the DSH process here.
${getStatusPluginEndpointSource().join('\n')}
${String.raw`
export const name = 'orca-dsh-console-status';
export const inject = ['agents', 'sessions'];

export function apply(ctx) {
  if (!process.env.ORCA_PANE_KEY || !process.env.ORCA_AGENT_LAUNCH_TOKEN) return;
  const records = new Map();
  const queue = [];
  let posting = false;
  let closed = false;
  let activeRequest;
  let activeId;
  const text = (value, max = 8000) => typeof value === 'string' ? value.slice(0, max) : '';
  const contentText = (content) => Array.isArray(content)
    ? content.filter((part) => part?.type === 'text').map((part) => text(part.text)).join('\n').slice(0, 8000)
    : '';
  const primary = (agent) => agent && /^dsh-console-[0-9a-f-]{36}$/i.test(String(agent.session.id))
    && ctx.agents.get(agent.id) === agent && ctx.agents.roots().includes(agent);
  const recordFor = (session) => {
    let record = records.get(session.id);
    if (!record) {
      record = { session, prompt: '', assistant: '', tool: '', toolInput: '', turn: null, waits: new Map() };
      records.set(session.id, record);
    }
    return record;
  };

  function enqueue(payload) {
    if (closed) return;
    // Bound observer memory during a disconnected receiver; every event carries the current snapshot.
    if (queue.length >= 64) queue.shift();
    queue.push(payload);
    drain();
  }
  function drain() {
    if (posting || queue.length === 0 || closed) return;
    const payload = queue.shift();
    const coords = resolveHookCoords();
    if (!/^\d+$/.test(coords.port || '') || !coords.token) {
      queue.length = 0;
      return;
    }
    const body = JSON.stringify({
      paneKey: process.env.ORCA_PANE_KEY,
      launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN,
      tabId: process.env.ORCA_TAB_ID || '',
      worktreeId: process.env.ORCA_WORKTREE_ID || '',
      env: coords.env, version: coords.version, payload
    });
    posting = true;
    let settled = false;
    let deadline;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      activeRequest = undefined;
      posting = false;
      drain();
    };
    try {
      // Native loopback HTTP bypasses provider proxy settings and never forwards hook credentials.
      const req = httpRequest({
        hostname: '127.0.0.1', port: Number(coords.port), path: '/hook/dsh-console', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
          'X-Orca-Agent-Hook-Token': coords.token }
      }, (res) => { res.resume(); res.on('end', finish); res.on('error', finish); });
      activeRequest = req;
      deadline = setTimeout(() => req.destroy(), 1000);
      req.on('error', finish);
      req.on('close', finish);
      req.end(body);
    } catch { finish(); }
  }
  function publish(record, hookEventName, extra = {}) {
    const wait = record.waits.values().next().value;
    const state = wait ? (wait.kind === 'approval' ? 'blocked' : 'waiting')
      : record.turn === null ? 'done' : 'working';
    enqueue({
      hook_event_name: hookEventName, session_id: String(record.session.id),
      turn_id: String(record.session.id) + ':' + String(record.turn ?? record.lastTurn ?? ''),
      state, prompt: record.prompt, tool_name: wait?.tool || record.tool,
      tool_input_preview: wait?.detail || record.toolInput,
      interactive_prompt: wait?.questions || '', last_assistant_message: record.assistant,
      ...extra
    });
  }
  ctx.on('agent/session-start', ({ agent }) => {
    if (!primary(agent)) return;
    const record = recordFor(agent.session);
    // An idle open/resume supplies identity, not a fabricated completed turn.
    publish(record, 'session_start');
  }, { global: true });
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id);
    if (!primary(agent)) return;
    const record = recordFor(session);
    if (event.type === 'turn/start') {
      activeId = session.id;
      record.turn = event.data.turn;
      record.prompt = '';
      record.assistant = '';
      record.tool = '';
      record.toolInput = '';
      record.waits.clear();
      publish(record, 'TurnStart');
    } else if (event.type === 'user/message') {
      if (event.data.source?.kind !== 'user') return;
      record.prompt = contentText(event.data.content).slice(0, 2000);
      publish(record, 'UserPromptSubmit');
    } else if (event.type === 'assistant/message') {
      record.assistant = contentText(event.data.message?.content);
    } else if (event.type === 'tool/call') {
      record.tool = text(event.data.name, 60);
      record.toolInput = '';
      publish(record, 'Tool');
    } else if (event.type === 'turn/end') {
      record.lastTurn = record.turn;
      record.turn = null;
      record.waits.clear();
      record.tool = '';
      record.toolInput = '';
      publish(record, 'Stop', {
        is_interrupt: event.data.reason?.kind === 'aborted',
        turn_completed_at: Date.now()
      });
    }
  }, { global: true });

  const observeWait = (kind) => async (request, next) => {
    if (!primary(request.agent) || request.signal?.aborted) return next();
    const record = recordFor(request.agent.session);
    const key = Symbol(kind);
    let questions = '';
    if (kind === 'question' && Array.isArray(request.questions)) {
      // The receiver uses the existing AskUserQuestion presentation; never include hidden model context.
      const projected = request.questions.slice(0, 3).map((q) => ({
        question: text(q.question, 1000), header: text(q.header, 100),
        options: (q.options || []).slice(0, 12).map((option) => ({
          label: text(option.label, 200), description: text(option.description, 400)
        })), multiSelect: q.multiSelect === true
      }));
      const encoded = JSON.stringify({ questions: projected });
      if (encoded.length <= 8000) questions = encoded;
    }
    record.waits.set(key, {
      kind, tool: kind === 'approval' ? text(request.toolName, 60) : 'AskUserQuestion',
      detail: kind === 'approval' ? text(request.reason, 160) : '', questions
    });
    publish(record, 'Interaction');
    try { return await next(); }
    finally {
      record.waits.delete(key);
      if (record.turn !== null && activeId === record.session.id) publish(record, 'Interaction');
    }
  };
  ctx.on('approval/request', observeWait('approval'), { prepend: true, global: true });
  ctx.on('user-questions/request', observeWait('question'), { prepend: true, global: true });
  ctx.on('agent/disposed', ({ agent }) => {
    records.delete(agent.session.id);
  }, { global: true });
  ctx.on('dispose', async () => {
    // Give the final real event a bounded chance to reach the existing receiver before app exit.
    const deadline = Date.now() + 1100;
    while ((posting || queue.length) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    closed = true;
    activeRequest?.destroy();
    queue.length = 0;
    records.clear();
  });
}
`}`
}
