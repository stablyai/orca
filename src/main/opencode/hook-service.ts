/* eslint-disable max-lines -- Why: holds an inline JS plugin source emitted as one file; splitting across TS modules would scatter tightly coupled string-template logic. */
import { app } from 'electron'
import { join } from 'node:path'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { mirrorEntry, safeRemoveTree } from '../pty/overlay-mirror'

const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'
const OPENCODE_LEGACY_HOOKS_DIR = 'opencode-hooks'
const OPENCODE_OVERLAY_DIR = 'opencode-config-overlays'
const OPENCODE_SHARED_CONFIG_DIR = 'shared'
const OPENCODE_OVERLAY_MANIFEST_FILE = '.orca-opencode-overlay-manifest.json'

type OpenCodeOverlayManifest = {
  topLevelEntries: string[]
  pluginEntries: string[]
}

// Why: bounds-check only — the id is a daemon sessionId with path separators, hashed downstream to a filesystem-safe name (an old regex rejecting "/"/":" broke every such id, #1148); 1024 just caps pathological hash input.
function isUsableId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && id.length <= 1024
}

function toSafeDirName(id: string): string {
  // Why: 32 hex chars (128 bits) makes collisions negligible and stays filesystem-portable (no base64 padding or `/`).
  return createHash('sha256').update(id).digest('hex').slice(0, 32)
}

export function getOpenCodePluginSource(): string {
  return getOpenCodeFamilyPluginSource('/hook/opencode')
}

export function getOpenCodeFamilyPluginSource(hookPathname: string): string {
  // Why: plugin runs in OpenCode's Node process and POSTs Orca's ORCA_* PTY env to the shared agent-hooks server; events are mapped plugin-side to fit the server's per-case switch.
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
    '// Why: message.part.updated re-sends the FULL accumulated text of the part',
    '// after every streamed append, so posting each event forwards O(n^2) bytes',
    '// per turn through Orca (loopback HTTP -> main JSON parse -> status compare',
    '// -> IPC -> renderer store update -> React commit). On Windows that flood',
    '// saturated both event loops and froze the whole UI a few seconds into a',
    '// streaming reply. The dashboard only needs a bounded preview at a human',
    '// cadence: cap the text and trailing-edge coalesce assistant parts.',
    'const MESSAGE_PART_THROTTLE_MS = 250;',
    'const MESSAGE_PART_MAX_CHARS = 4000;',
    'let pendingAssistantPart = null;',
    'let assistantPartFlushTimer = null;',
    'let lastAssistantPartPostAt = 0;',
    '',
    'function capMessagePartText(text) {',
    '  return text.length > MESSAGE_PART_MAX_CHARS ? text.slice(0, MESSAGE_PART_MAX_CHARS) : text;',
    '}',
    '',
    'async function flushPendingAssistantPart() {',
    '  if (assistantPartFlushTimer) {',
    '    clearTimeout(assistantPartFlushTimer);',
    '    assistantPartFlushTimer = null;',
    '  }',
    '  const pending = pendingAssistantPart;',
    '  pendingAssistantPart = null;',
    '  if (!pending) return;',
    '  lastAssistantPartPostAt = Date.now();',
    '  await post("MessagePart", {',
    '    role: pending.role,',
    '    text: capMessagePartText(pending.text),',
    '    messageID: pending.messageID,',
    '    sessionID: pending.sessionID,',
    '  });',
    '}',
    '',
    'function queueAssistantPart(part) {',
    '  // Why: keep only the latest snapshot — each event already contains the',
    '  // full accumulated text, so intermediate snapshots are pure waste.',
    '  pendingAssistantPart = part;',
    '  const sinceLastPost = Date.now() - lastAssistantPartPostAt;',
    '  if (sinceLastPost >= MESSAGE_PART_THROTTLE_MS) {',
    '    void flushPendingAssistantPart();',
    '    return;',
    '  }',
    '  if (!assistantPartFlushTimer) {',
    '    assistantPartFlushTimer = setTimeout(() => {',
    '      void flushPendingAssistantPart();',
    '    }, MESSAGE_PART_THROTTLE_MS - sinceLastPost);',
    '    if (assistantPartFlushTimer.unref) assistantPartFlushTimer.unref();',
    '  }',
    '}',
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
    '// Detect child sessions by checking `parentID` via client.session.list(),',
    '// cache the result per session, and fail closed (assume child) on lookup errors',
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
    `  const url = \`http://127.0.0.1:\${coords.port}${hookPathname}\`;`,
    '  const body = JSON.stringify({',
    '    paneKey,',
    '    launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN || "",',
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
    '      if (role === "user") {',
    '        // Why: user prompts arrive as a single event, not a stream — post',
    '        // immediately (still capped) so the throttle slot stays free for',
    '        // the assistant reply that follows within the same window.',
    '        await post("MessagePart", { role, text: capMessagePartText(part.text), messageID: part.messageID, sessionID });',
    '        return;',
    '      }',
    '      queueAssistantPart({ role, text: part.text, messageID: part.messageID, sessionID });',
    '      return;',
    '    }',
    '',
    '    if (event.type === "session.idle" || event.type === "session.error") {',
    '      // Why: flush the coalesced final reply snapshot before the idle',
    '      // transition so the done-state preview shows the completed message.',
    '      await flushPendingAssistantPart();',
    '      await setStatus("idle", { sessionID });',
    '      return;',
    '    }',
    '',
    '    if (event.type === "session.status") {',
    '      const statusType = getStatusType(event);',
    '      if (statusType === "busy" || statusType === "retry") {',
    '        await setStatus("busy", { sessionID });',
    '        return;',
    '      }',
    '      if (statusType === "idle") {',
    '        await setStatus("idle", { sessionID });',
    '      }',
    '    }',
    '  },',
    '  };',
    '};',
    ''
  ].join('\n')
}

// Why: installs the plugin into OPENCODE_CONFIG_DIR so it POSTs to the shared agent-hooks server, unifying OpenCode status with Claude/Codex/Gemini (the old loopback-IPC path never reached agentStatusByPaneKey).
export class OpenCodeHookService {
  clearPty(_ptyId: string): void {
    // Why: no-op — config dirs are app/source-scoped now, and recursive delete on the main-process hot path could freeze on Windows.
  }

  buildPtyEnv(ptyId: string, existingConfigDir?: string | undefined): Record<string, string> {
    if (!isUsableId(ptyId)) {
      // Why: on a bad id, still preserve a user-set OPENCODE_CONFIG_DIR; only the Orca status plugin is forfeited.
      return existingConfigDir ? { OPENCODE_CONFIG_DIR: existingConfigDir } : {}
    }

    if (!existingConfigDir) {
      // Why: share one config root so OpenCode's plugin deps don't churn node_modules per terminal.
      const configDir = this.writeSharedPluginConfig()
      if (!configDir) {
        return {}
      }
      return { OPENCODE_CONFIG_DIR: configDir }
    }

    // Why: don't mkdir the user's (possibly typoed) path — that's the config-replacement failure mode in docs/opencode-config-dir-collision.md; let OpenCode surface it.
    if (!existsSync(existingConfigDir)) {
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }

    const overlayDir = this.getSourceOverlayDir(existingConfigDir)

    try {
      mkdirSync(overlayDir, { recursive: true })
      this.mirrorUserConfig(existingConfigDir, overlayDir)
      this.writePluginIntoOverlay(overlayDir)
    } catch {
      // Why: best-effort — symlink creation needs Windows developer mode (else EPERM) and userData may be read-only; preserve the user's config over dropping their auth/models/keymap.
      return { OPENCODE_CONFIG_DIR: existingConfigDir }
    }

    return { OPENCODE_CONFIG_DIR: overlayDir }
  }

  private getOverlayRoot(): string {
    return join(app.getPath('userData'), OPENCODE_OVERLAY_DIR)
  }

  private getSourceOverlayDir(sourceConfigDir: string): string {
    return join(this.getOverlayRoot(), toSafeDirName(`source:${sourceConfigDir}`))
  }

  private getSharedConfigDir(): string {
    return join(app.getPath('userData'), OPENCODE_LEGACY_HOOKS_DIR, OPENCODE_SHARED_CONFIG_DIR)
  }

  private readOverlayManifest(overlayDir: string): OpenCodeOverlayManifest {
    try {
      const parsed = JSON.parse(
        readFileSync(join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE), 'utf8')
      ) as Partial<OpenCodeOverlayManifest>
      return {
        topLevelEntries: Array.isArray(parsed.topLevelEntries) ? parsed.topLevelEntries : [],
        pluginEntries: Array.isArray(parsed.pluginEntries) ? parsed.pluginEntries : []
      }
    } catch {
      return { topLevelEntries: [], pluginEntries: [] }
    }
  }

  private writeOverlayManifest(overlayDir: string, manifest: OpenCodeOverlayManifest): void {
    writeFileSync(
      join(overlayDir, OPENCODE_OVERLAY_MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`
    )
  }

  private clearManifestEntries(overlayDir: string, manifest: OpenCodeOverlayManifest): void {
    for (const entryName of manifest.topLevelEntries) {
      safeRemoveTree(join(overlayDir, entryName))
    }

    const overlayPluginsDir = join(overlayDir, 'plugins')
    for (const entryName of manifest.pluginEntries) {
      if (entryName === ORCA_OPENCODE_PLUGIN_FILE) {
        continue
      }
      safeRemoveTree(join(overlayPluginsDir, entryName))
    }
  }

  // Why: mirror user config entries as symlinks so edits propagate live; only plugins/ becomes a real overlay dir so Orca can drop a sibling plugin file.
  private mirrorUserConfig(sourceDir: string, overlayDir: string): void {
    const previousManifest = this.readOverlayManifest(overlayDir)
    // Why: overlays persist across terminals; remove only Orca-mirrored paths so stale user config clears but OpenCode runtime dirs (node_modules) survive.
    this.clearManifestEntries(overlayDir, previousManifest)

    const nextManifest: OpenCodeOverlayManifest = { topLevelEntries: [], pluginEntries: [] }

    for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
      const sourcePath = join(sourceDir, entry.name)

      if (entry.name === 'plugins') {
        // Why: check isSymbolicLink before isDirectory — a Windows junction reports both, and the symlink branch must win.
        const isSymlink = entry.isSymbolicLink()
        let isLinkPointingToDir = false
        if (isSymlink) {
          try {
            isLinkPointingToDir = statSync(sourcePath).isDirectory()
          } catch {
            // Why: broken/inaccessible symlink — mirror the dangling link verbatim instead of resolving through it.
            isLinkPointingToDir = false
          }
        }

        if ((!isSymlink && entry.isDirectory()) || isLinkPointingToDir) {
          // Why: resolve a symlinked plugins/ to its real target so <overlay>/plugins stays a real dir and writePluginIntoOverlay can't write through the user's link.
          const resolvedSource = isLinkPointingToDir ? realpathSync(sourcePath) : sourcePath
          const overlayPluginsDir = join(overlayDir, 'plugins')
          mkdirSync(overlayPluginsDir, { recursive: true })
          for (const pluginEntry of readdirSync(resolvedSource, { withFileTypes: true })) {
            // Why: skip a user plugin sharing Orca's filename; mirroring it would let writePluginIntoOverlay clobber the user's file.
            if (pluginEntry.name === ORCA_OPENCODE_PLUGIN_FILE) {
              continue
            }
            mirrorEntry(
              join(resolvedSource, pluginEntry.name),
              join(overlayPluginsDir, pluginEntry.name)
            )
            nextManifest.pluginEntries.push(pluginEntry.name)
          }
          continue
        }
      }

      mirrorEntry(sourcePath, join(overlayDir, entry.name))
      nextManifest.topLevelEntries.push(entry.name)
    }

    this.writeOverlayManifest(overlayDir, nextManifest)
  }

  // Why: pre-write unlink guards against POSIX writeFileSync writing through a mirrored symlink and clobbering a same-named user plugin.
  private writePluginIntoOverlay(overlayDir: string): void {
    const pluginsDir = join(overlayDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    const pluginPath = join(pluginsDir, ORCA_OPENCODE_PLUGIN_FILE)
    try {
      unlinkSync(pluginPath)
    } catch {
      // File may not exist on a fresh overlay; a real failure surfaces on writeFileSync below.
    }
    writeFileSync(pluginPath, getOpenCodePluginSource())
  }

  private writeSharedPluginConfig(): string | null {
    const configDir = this.getSharedConfigDir()
    const pluginsDir = join(configDir, 'plugins')
    try {
      mkdirSync(pluginsDir, { recursive: true })
      writeFileSync(join(pluginsDir, ORCA_OPENCODE_PLUGIN_FILE), getOpenCodePluginSource())
    } catch {
      // Why: userData can be locked on Windows (EPERM/EBUSY); plugin is non-critical, so spawn without it.
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
