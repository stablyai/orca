/* eslint-disable max-lines -- Why: this file contains a multi-line inline
   JS plugin source emitted into OpenCode's plugins directory as a single
   file; splitting the plugin source across TS modules would obscure the
   runtime artifact and scatter tightly coupled string-template logic. */
import { app } from 'electron'
import { join } from 'path'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { createHash } from 'crypto'

const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'

// Why: the id passed in by pty.ts's daemon path is a sessionId shaped like
// "<worktreeId>@@<uuid>" where worktreeId itself contains "::" and a
// filesystem path (slashes, colons). Earlier the id was a simple numeric
// counter, so rejecting anything with "/" or ":" was a safe guard against
// path traversal. After the daemon-parity refactor (#1148) the sessionId
// shape changed, and the old regex silently rejected every legitimate id,
// leaving OPENCODE_CONFIG_DIR unset and the plugin never loading.
//
// Keep an input-bounds guard (non-empty, bounded length) for defense in
// depth, and derive the on-disk directory name via hash so any caller's id —
// including ones containing path separators — produces a short, stable,
// filesystem-safe name. Hashing also eliminates path-traversal risk at the
// source: the directory name is always 32 hex chars, never a prefix/suffix
// of the caller's input.
// Why: 1024 is a generous sanity cap — daemon-shaped ids embed a worktree
// filesystem path plus "@@<uuid>", and this bound prevents pathological inputs
// from burning CPU in the SHA-256 step. Since the id is hashed anyway, 1024
// is decoupled from PATH_MAX.
function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

function toSafeDirName(id: string): string {
  // Why: SHA-256 truncated to 32 hex chars (128 bits) is ample for a
  // per-session directory name — collisions require ~2^64 concurrent sessions
  // to become likely, far beyond any real workload. Hex keeps the name
  // portable across all filesystems (no base64 padding, no `/`).
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
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
    '// Why: process-lifetime guard so a recurring parse error on a malformed',
    "// endpoint file does not spam OpenCode's stderr once per hook post.",
    '// This guard lives inside the plugin source because the plugin runs in',
    "// OpenCode's Node process (not Orca's) and has no access to server.ts's",
    '// equivalent warnedVersions / warnedEnvs Sets.',
    'let warnedBadEndpoint = false;',
    '',
    '// Why: message.part.updated can fire many times per second during a',
    '// streaming assistant reply, and each post() calls resolveHookCoords()',
    '// which reads the endpoint file. The file only changes on Orca restart',
    '// (rare), so a stat+mtime check is substantially cheaper than a full',
    '// readFileSync+parse on every streamed part. On stat error we fall',
    '// through to parse so the fail-open behavior is preserved.',
    'let cachedEndpointKey = "";',
    'let cachedEndpointValues = null;',
    '',
    'function readEndpointFile() {',
    '  const path = process.env.ORCA_AGENT_HOOK_ENDPOINT;',
    '  if (!path) return null;',
    '  try {',
    '    const fs = require("fs");',
    '    try {',
    '      const stat = fs.statSync(path);',
    '      // Why: cache key combines mtime + size + inode. renameSync (used by',
    '      // writeEndpointFile on the Orca side) allocates a fresh inode on',
    '      // POSIX and a new Windows file ID on NTFS, so ino changes on every',
    '      // legitimate rewrite even when mtimeMs resolution is coarse and size',
    '      // happens to match.',
    '      const cacheKey = stat.mtimeMs + ":" + stat.size + ":" + stat.ino;',
    '      if (cacheKey === cachedEndpointKey && cachedEndpointValues) {',
    '        return cachedEndpointValues;',
    '      }',
    '      const contents = fs.readFileSync(path, "utf8");',
    '      const out = {};',
    '      for (const line of contents.split(/\\r?\\n/)) {',
    '        // Why: Windows endpoint.cmd uses `set KEY=VALUE`; Unix endpoint.env',
    '        // uses `KEY=VALUE`. Making `set ` optional lets the same parser',
    '        // handle both without platform detection in the plugin. Allow',
    '        // digits in the key for forward-compat with future ORCA_AGENT_HOOK_*',
    '        // names that may contain numerics, and strip a trailing CR so',
    '        // mixed-EOL files with lone `\\r` do not leak CR into the value.',
    '        const m = line.match(/^(?:set\\s+)?([A-Z0-9_]+)=(.*)$/);',
    '        if (m) out[m[1]] = m[2].replace(/\\r$/, "");',
    '      }',
    '      cachedEndpointKey = cacheKey;',
    '      cachedEndpointValues = out;',
    '      return out;',
    '    } catch (ioErr) {',
    '      // Why: any stat or read failure (file yanked mid-read, permission',
    '      // race, unlink between stat and readFileSync) must invalidate the',
    '      // cache so a transient failure does not lock in a stale parse for',
    '      // the remaining process lifetime; rethrow to the outer catch.',
    '      cachedEndpointKey = "";',
    '      cachedEndpointValues = null;',
    '      throw ioErr;',
    '    }',
    '  } catch (err) {',
    '    // Why: warn once per process if the file exists but is unreadable or',
    '    // malformed — a persistent, silently-swallowed parse error would',
    '    // otherwise leave the plugin falling back to stale process.env on',
    '    // every post with no signal. ENOENT / missing env var is the normal',
    '    // pre-install case; stay silent for it.',
    '    if (err && err.code !== "ENOENT" && !warnedBadEndpoint) {',
    '      warnedBadEndpoint = true;',
    '      console.warn("[orca-hook] failed to parse endpoint file:", err.message);',
    '    }',
    '    return null;',
    '  }',
    '}',
    '',
    'function resolveHookCoords() {',
    '  // Why: prefer the on-disk endpoint file over process.env because env was',
    '  // frozen when OpenCode was fork()ed — stale after an Orca restart. The',
    '  // file is rewritten on every Orca start(), so sourcing it per post lets',
    '  // a long-running OpenCode session reach the current server. Falls back',
    '  // to process.env when the file is absent (first-run / pre-endpoint-file / Orca',
    '  // never started writing the file).',
    '  const fileEnv = readEndpointFile() || {};',
    '  return {',
    '    port: fileEnv.ORCA_AGENT_HOOK_PORT || process.env.ORCA_AGENT_HOOK_PORT,',
    '    token: fileEnv.ORCA_AGENT_HOOK_TOKEN || process.env.ORCA_AGENT_HOOK_TOKEN,',
    '    env: fileEnv.ORCA_AGENT_HOOK_ENV || process.env.ORCA_AGENT_HOOK_ENV || "",',
    '    version: fileEnv.ORCA_AGENT_HOOK_VERSION || process.env.ORCA_AGENT_HOOK_VERSION || "",',
    '  };',
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
    '  // Why: resolve coords per post — the endpoint file may have been',
    '  // rewritten by a newer Orca since the last call. Pane/tab/worktree IDs',
    '  // stay on process.env because they are per-PTY (stable for the life of',
    '  // the OpenCode process), not per-Orca-instance.',
    '  const coords = resolveHookCoords();',
    '  const paneKey = process.env.ORCA_PANE_KEY;',
    '  if (!coords.port || !coords.token || !paneKey) return;',
    '  const url = `http://127.0.0.1:${coords.port}/hook/opencode`;',
    '  const body = JSON.stringify({',
    '    paneKey,',
    '    tabId: process.env.ORCA_TAB_ID || "",',
    '    worktreeId: process.env.ORCA_WORKTREE_ID || "",',
    '    env: coords.env,',
    '    version: coords.version,',
    '    payload: { hook_event_name: hookEventName, ...(extraProperties || {}) },',
    '  });',
    '  try {',
    '    await fetch(url, {',
    '      method: "POST",',
    '      headers: {',
    '        "Content-Type": "application/json",',
    '        "X-Orca-Agent-Hook-Token": coords.token,',
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
    '    if (event.type === "question.asked") {',
    '      // Why: question.asked fires when OpenCode uses an ask-the-user tool',
    '      // (distinct from permission.asked, which blocks on tool approval).',
    '      // The agent is idle-but-waiting on a human reply, not running, so we',
    '      // must flip the pane to the same red "needs attention" state used for',
    '      // permission requests. Like permission.asked, do not touch lastStatus',
    '      // so the next SessionBusy/SessionIdle after the user answers still',
    '      // fires and restores the normal working/done flow.',
    '      await post("AskUserQuestion", event.properties || {});',
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
    if (!isUsableId(ptyId)) {
      return
    }
    // Why: writePluginConfig creates a directory per PTY under userData.
    // Without cleanup these accumulate across sessions. Using getConfigDir
    // keeps cleanup aligned with the path writePluginConfig created.
    const configDir = this.getConfigDir(ptyId)
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

  private getConfigDir(ptyId: string): string {
    return join(app.getPath('userData'), 'opencode-hooks', toSafeDirName(ptyId))
  }

  private writePluginConfig(ptyId: string): string | null {
    if (!isUsableId(ptyId)) {
      return null
    }
    const configDir = this.getConfigDir(ptyId)
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
  isUsableId,
  toSafeDirName
}
