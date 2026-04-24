import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'

const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'

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
    'export const OrcaOpenCodeStatusPlugin = async (_ctx) => ({',
    '  event: async ({ event }) => {',
    '    if (!event?.type) return;',
    '',
    '    // TODO(opencode-subagents): filter out child-session events before',
    '    // emitting state transitions. When tools like oh-my-opencode spawn',
    '    // background subagents (explore, librarian, oracle), each subagent',
    '    // runs in its own OpenCode session and emits its own session.idle,',
    '    // which this plugin will currently treat as "agent done" and flip the',
    '    // dashboard to done before the root turn actually finishes. Superset',
    '    // fixes this by calling `client.session.list()` and skipping any',
    '    // session whose `parentID` is set — with a cache so the lookup',
    '    // cost is paid once per sessionID, and with the safe default of',
    '    // treating lookup errors as "assume child" to avoid false positives.',
    '    // See apps/desktop/src/main/lib/agent-setup/templates/opencode-',
    '    // plugin.template.js in superset-sh/superset for the v8 reference.',
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
    '      // Why: message.updated carries the full Message object with role',
    '      // (user | assistant). We only use it to remember the role for later',
    '      // message.part.updated events; the text content itself arrives via',
    '      // TextPart. See @opencode-ai/sdk EventMessageUpdated.properties.info.',
    '      const info = event.properties && event.properties.info;',
    '      rememberMessageRole(info && info.id, info && info.role);',
    '      return;',
    '    }',
    '',
    '    if (event.type === "message.part.updated") {',
    '      // Why: a TextPart carries the actual user prompt or assistant reply',
    '      // text. Skip non-text parts (tool, reasoning, file, …) so we only',
    '      // forward what the dashboard renders. Role came from the earlier',
    '      // message.updated event; if we never saw one (e.g. plugin loaded',
    '      // mid-turn), default to assistant — that is the more useful side',
    '      // to surface on done, and a missing user prompt is a cheaper miss.',
    '      const part = event.properties && event.properties.part;',
    '      if (!part || part.type !== "text" || !part.text) return;',
    '      const role = messageRoleById.get(part.messageID) || "assistant";',
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
    '});',
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
  private registeredPtyIds = new Set<string>()

  clearPty(ptyId: string): void {
    this.registeredPtyIds.delete(ptyId)
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
    this.registeredPtyIds.add(ptyId)
    return configDir
  }
}

export const openCodeHookService = new OpenCodeHookService()
