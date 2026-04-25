import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'

const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'

// Why: ptyId today is allocated by Orca (safe UUID-shape), but both entry
// points construct a filesystem path with it and one of them calls
// rmSync(..., recursive) on the result. Reject obviously unsafe IDs as a
// belt-and-braces guard so a future caller (or a bug that forwards an
// external ID) cannot escape userData/opencode-hooks/.
function isSafePtyId(ptyId: string): boolean {
  if (!ptyId || ptyId.length === 0 || ptyId.length > 128) {
    return false
  }
  // Allow alphanumeric, dash, underscore, period (but not leading period or
  // any slashes/backslashes).
  return /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(ptyId) && !ptyId.includes('..')
}

function getOpenCodePluginSource(): string {
  // Why: the plugin runs inside the OpenCode Node process and POSTs to the
  // unified agent-hooks server shared with Claude/Codex/Gemini. It reads the
  // same ORCA_PANE_KEY / ORCA_TAB_ID / ORCA_WORKTREE_ID / ORCA_AGENT_HOOK_*
  // env vars that Orca injects into every PTY, so OpenCode panes flow into
  // agentStatusByPaneKey via the same IPC path as every other agent. Event
  // mapping is done plugin-side (SessionBusy / SessionIdle / PermissionRequest)
  // so the server-side normalizer can keep its one-event-per-case switch shape.
  return [
    'function getHookUrl() {',
    '  const port = process.env.ORCA_AGENT_HOOK_PORT;',
    '  return port ? `http://127.0.0.1:${port}/hook/opencode` : null;',
    '}',
    '',
    'function getStatusType(event) {',
    '  return event?.properties?.status?.type ?? event?.status?.type ?? null;',
    '}',
    '',
    'let lastStatus = "idle";',
    'const childSessionById = new Map();',
    '',
    '// Why: message.part.updated fires for every Part (text, tool, reasoning)',
    '// but does not include the message role — that lives on the parent',
    '// message.updated event. Cache the role per messageID so the plugin can',
    '// tag a TextPart as user vs assistant when POSTing. Capped at 128 entries',
    '// so long-running sessions do not grow this map unboundedly.',
    'const messageRoleById = new Map();',
    'function rememberMessageRole(messageID, role) {',
    '  if (!messageID || !role) return;',
    '  if (messageRoleById.size >= 128) {',
    '    const first = messageRoleById.keys().next().value;',
    '    if (first !== undefined) messageRoleById.delete(first);',
    '  }',
    '  messageRoleById.set(messageID, role);',
    '}',
    '',
    '// Why: oh-my-opencode style tools spawn child sessions that emit their',
    '// own session.idle / message events. Those child completions must not',
    '// flip the root Orca pane to done or overwrite the parent turn preview.',
    '// Match Superset by checking `parentID` via client.session.list(), cache',
    '// the result per session, and fail closed (assume child) on lookup errors',
    '// so a transient SDK failure cannot create false "done" transitions.',
    'async function isChildSession(client, sessionID) {',
    '  if (!sessionID) return true;',
    '  if (childSessionById.has(sessionID)) return childSessionById.get(sessionID);',
    '  if (!client?.session?.list) return true;',
    '  try {',
    '    const sessions = await client.session.list();',
    '    const list = Array.isArray(sessions?.data) ? sessions.data : [];',
    '    const session = list.find((entry) => entry?.id === sessionID);',
    '    const isChild = !!session?.parentID;',
    '    if (childSessionById.size >= 128) {',
    '      const first = childSessionById.keys().next().value;',
    '      if (first !== undefined) childSessionById.delete(first);',
    '    }',
    '    childSessionById.set(sessionID, isChild);',
    '    return isChild;',
    '  } catch {',
    '    return true;',
    '  }',
    '}',
    '',
    'async function post(hookEventName, extraProperties) {',
    '  const url = getHookUrl();',
    '  const token = process.env.ORCA_AGENT_HOOK_TOKEN;',
    '  const paneKey = process.env.ORCA_PANE_KEY;',
    '  if (!url || !token || !paneKey) return;',
    '  const body = JSON.stringify({',
    '    paneKey,',
    '    tabId: process.env.ORCA_TAB_ID || "",',
    '    worktreeId: process.env.ORCA_WORKTREE_ID || "",',
    '    env: process.env.ORCA_AGENT_HOOK_ENV || "",',
    '    version: process.env.ORCA_AGENT_HOOK_VERSION || "",',
    '    payload: { hook_event_name: hookEventName, ...(extraProperties || {}) },',
    '  });',
    '  try {',
    '    await fetch(url, {',
    '      method: "POST",',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '        "X-Orca-Agent-Hook-Token": token,',
    '      },',
    '      body,',
    '    });',
    '  } catch {',
    '    // Why: OpenCode session events must never fail the agent run just',
    '    // because Orca is unavailable or the local loopback request failed.',
    '  }',
    '}',
    '',
    'async function setStatus(next, extraProperties) {',
    '  // Why: dedupe so a flurry of session.status idle events after a turn',
    '  // does not spam the dashboard with redundant done transitions.',
    '  if (lastStatus === next) return;',
    '  lastStatus = next;',
    '  const hookEventName = next === "busy" ? "SessionBusy" : "SessionIdle";',
    '  await post(hookEventName, extraProperties);',
    '}',
    '',
    '// Why: accept the factory argument as an optional opaque parameter instead',
    '// of destructuring (`async ({ client }) => …`). OpenCode can invoke the',
    '// plugin factory with undefined during startup, which makes the',
    '// destructuring form throw synchronously and crash OpenCode with an opaque',
    '// UnknownError before any event is ever dispatched.',
    'export const OrcaOpenCodeStatusPlugin = async (_ctx) => {',
    '  const client = _ctx?.client;',
    '  return {',
    '  event: async ({ event }) => {',
    '    if (!event?.type) return;',
    '',
    '    // Why: cache the message role BEFORE the async isChildSession check.',
    '    // OpenCode fires message.updated (user) and message.part.updated (text)',
    '    // back-to-back; if we awaited isChildSession first, the part.updated',
    '    // handler could reach messageRoleById.get(...) while the user message.updated',
    '    // is still suspended on that await — so the part would see an empty cache',
    '    // and drop the user prompt. Caching is a cheap Map.set with bounded size,',
    '    // safe to run even for child sessions (the part POST still filters them).',
    '    if (event.type === "message.updated") {',
    '      const info = event.properties && event.properties.info;',
    '      rememberMessageRole(info && info.id, info && info.role);',
    '    }',
    '',
    '    const sessionID = event.properties?.sessionID;',
    '    if (sessionID && (await isChildSession(client, sessionID))) {',
    '      return;',
    '    }',
    '',
    '    if (event.type === "permission.asked") {',
    '      // Why: permission asks are not a session state transition — emit',
    '      // without mutating lastStatus so the next SessionBusy/SessionIdle',
    '      // still fires. The server maps PermissionRequest to `waiting`.',
    '      await post("PermissionRequest", event.properties || {});',
    '      return;',
    '    }',
    '',
    '    if (event.type === "message.updated") {',
    '      // Why: role is already cached above the isChildSession await so the',
    '      // back-to-back message.part.updated for the same messageID is not',
    '      // racing against this handler. Nothing more to do here — return to',
    '      // avoid falling through to the part/session handlers below.',
    '      return;',
    '    }',
    '',
    '    if (event.type === "message.part.updated") {',
    '      // Why: a TextPart carries the actual user prompt or assistant reply',
    '      // text. Skip non-text parts (tool, reasoning, file, …) so we only',
    '      // forward what the dashboard renders. Role came from the earlier',
    '      // message.updated event; if we never saw one (e.g. plugin loaded',
    '      // mid-turn) the role is unknown, and mislabeling the part — a user',
    '      // prompt displayed as the assistant reply, or vice versa — is worse',
    '      // than silently dropping a single in-flight text chunk. The next',
    '      // message.updated event will re-seed the role cache, so subsequent',
    '      // parts in the same session flow normally.',
    '      const part = event.properties && event.properties.part;',
    '      if (!part || part.type !== "text" || !part.text) return;',
    '      const role = messageRoleById.get(part.messageID);',
    '      if (!role) return;',
    '      await post("MessagePart", { role, text: part.text });',
    '      return;',
    '    }',
    '',
    '    if (event.type === "session.idle" || event.type === "session.error") {',
    '      await setStatus("idle");',
    '      return;',
    '    }',
    '',
    '    if (event.type === "session.status") {',
    '      const statusType = getStatusType(event);',
    '      if (statusType === "busy" || statusType === "retry") {',
    '        await setStatus("busy");',
    '        return;',
    '      }',
    '      if (statusType === "idle") {',
    '        await setStatus("idle");',
    '      }',
    '    }',
    '  },',
    '  };',
    '};',
    ''
  ].join('\n')
}

// Why: OpenCode hooks used to run their own loopback HTTP server + IPC
// channel (pty:opencode-status). That pathway produced a synthetic terminal
// title but never entered agentStatusByPaneKey, so the unified dashboard
// never saw OpenCode sessions. The service now only installs the plugin
// file into OPENCODE_CONFIG_DIR — the plugin POSTs directly to the shared
// agent-hooks server (/hook/opencode), so OpenCode rides the same status
// pipeline as Claude/Codex/Gemini.
export class OpenCodeHookService {
  clearPty(ptyId: string): void {
    if (!isSafePtyId(ptyId)) {
      return
    }
    // Why: writePluginConfig creates a directory per PTY under userData. Without
    // cleanup these accumulate across sessions since ptyId is a monotonically
    // increasing counter. Remove the directory when the PTY is torn down.
    const configDir = join(app.getPath('userData'), 'opencode-hooks', ptyId)
    try {
      rmSync(configDir, { recursive: true, force: true })
    } catch {
      // Why: best-effort cleanup. The directory may already be gone if the user
      // manually purged userData, or the OS may hold a lock briefly.
    }
  }

  buildPtyEnv(ptyId: string): Record<string, string> {
    const configDir = this.writePluginConfig(ptyId)
    if (!configDir) {
      // Why: plugin config is best-effort. Returning an empty object lets the
      // PTY spawn without the OpenCode plugin when the filesystem is locked;
      // the agent-hooks env (ORCA_AGENT_HOOK_PORT/TOKEN/ORCA_PANE_KEY) is
      // still injected separately by ipc/pty.ts so other agents keep working.
      return {}
    }

    // Why: OPENCODE_CONFIG_DIR points OpenCode at a plugin directory we own.
    // Injecting it into every Orca PTY means manually launched `opencode`
    // sessions automatically pick up the status plugin too, not just sessions
    // started from a hardcoded command template.
    return { OPENCODE_CONFIG_DIR: configDir }
  }

  private writePluginConfig(ptyId: string): string | null {
    if (!isSafePtyId(ptyId)) {
      return null
    }
    const configDir = join(app.getPath('userData'), 'opencode-hooks', ptyId)
    const pluginsDir = join(configDir, 'plugins')
    try {
      mkdirSync(pluginsDir, { recursive: true })
      writeFileSync(join(pluginsDir, ORCA_OPENCODE_PLUGIN_FILE), getOpenCodePluginSource())
    } catch {
      // Why: on Windows, userData directories can be locked by antivirus or
      // indexers (EPERM/EBUSY). Plugin config is non-critical — the PTY should
      // still spawn without the OpenCode status plugin.
      return null
    }
    return configDir
  }
}

export const openCodeHookService = new OpenCodeHookService()
export const _internals = {
  getOpenCodePluginSource,
  isSafePtyId
}
