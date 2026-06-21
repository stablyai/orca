// Why: jcode's chat-bubble view (M1) needs CLEAN newline-delimited JSON on
// stdout, so it is spawned with node child_process — NOT a PTY. A PTY would
// inject terminal control sequences and line-wrapping that corrupt the JSON
// stream. Each `jcode run ... --ndjson <prompt>` invocation is one-shot: it
// emits NDJSON then exits. Conversations continue via --resume <sessionId>,
// captured from the 'start'/'done' events on a previous turn.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import { type BrowserWindow, dialog, ipcMain } from 'electron'
import type { Store } from '../persistence'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import {
  JCODE_CHAT_DELETE_CHANNEL,
  JCODE_CHAT_EVENT_CHANNEL,
  JCODE_CHAT_LIST_CHANNEL,
  JCODE_CHAT_LOAD_CHANNEL,
  JCODE_CHAT_PICK_FILES_CHANNEL,
  JCODE_CHAT_SAVE_CHANNEL,
  JCODE_CHAT_SEND_CHANNEL,
  JCODE_CHAT_STOP_CHANNEL,
  type JcodeChatSavePayload,
  type JcodeChatSendPayload,
  type JcodeChatStopPayload,
  type JcodeNdjsonEvent
} from '../../shared/jcode-chat-types'
import {
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversation
} from './jcode-conversation-store'
import { resolveTurnPrompt, type RemoteExecResolution } from './jcode-attachments'
import { applySkillInjection, registerJcodeSkillsHandler } from './jcode-skills'

// Why: jcode is installed via cargo; the absolute path avoids depending on the
// (often empty under Electron) PATH. Mirrors the pinned tool path the desktop
// prototype and CLI verification use.
const JCODE_BIN = '/Users/vinny/.cargo/bin/jcode'

/** One in-flight turn per sessionKey. A new send for the same key cancels the
 *  previous child first (defensive — the renderer should not double-send). */
const activeChildren = new Map<string, ChildProcessWithoutNullStreams>()

/** sessionKeys whose child was killed by an explicit user Stop. Used so the
 *  'close' handler emits a 'stopped' event instead of a spurious 'error'. */
const stoppedKeys = new Set<string>()

function sendEvent(mainWindow: BrowserWindow, sessionKey: string, event: JcodeNdjsonEvent): void {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return
  }
  mainWindow.webContents.send(JCODE_CHAT_EVENT_CHANNEL, { sessionKey, event })
}

function buildArgs(
  payload: JcodeChatSendPayload,
  remoteExecHost: string | null,
  resolvedPrompt: string
): string[] {
  // A named custom profile (from `jcode provider add`) is selected with
  // `--provider-profile <name>` (which IMPLIES openai-compatible) and MUST NOT
  // also pass `-p`; doing both would be ambiguous. It takes precedence over the
  // built-in `-p provider` path. `-m model` still overrides the profile default.
  const profile = payload.providerProfile?.trim()
  let args: string[]
  if (profile) {
    args = ['run', '--provider-profile', profile]
  } else {
    const provider = payload.provider?.trim() || 'openai'
    args = ['run', '-p', provider]
  }
  if (payload.model?.trim()) {
    args.push('-m', payload.model.trim())
  }
  // jcode's `-C/--cwd` does a LOCAL std::env::set_current_dir for ANY value,
  // independent of --remote-exec (startup.rs parse_and_prepare_args). For a
  // remote turn payload.cwd is the REMOTE project path, which does not exist on
  // the Mac, so passing -C would crash the local process with ENOENT. Omit -C
  // for remote turns; the remote bash then runs in the remote login home (~).
  // (A jcode-binary change is needed to make -C set ONLY the remote working dir
  // under --remote-exec — see jcodeBinaryFollowup.) Local turns keep -C as-is.
  if (!remoteExecHost && payload.cwd?.trim()) {
    args.push('-C', payload.cwd.trim())
  }
  if (payload.resumeSessionId?.trim()) {
    args.push('--resume', payload.resumeSessionId.trim())
  }
  // brain-local / hands-remote (M3): jcode itself runs LOCALLY (local auth/model)
  // — only bash executes on this remote host. The host is resolved authoritatively
  // from the worktree's SSH target in the main process; see resolveRemoteExecHost.
  if (remoteExecHost) {
    args.push('--remote-exec', remoteExecHost)
  }
  args.push('--ndjson', resolvedPrompt)
  return args
}

/** Resolve the brain-local (M3) remote-exec host for a chat turn.
 *  A jcode chat opened in ANY connectionId-remote folder workspace implies
 *  remote execution: jcode runs locally (local auth/model) but its bash/read
 *  tools execute on the remote host. So we emit --remote-exec whenever the
 *  worktree's folder workspace has an SSH connection — not only when the user
 *  manually toggled `isRemoteExecOnly`. (The folderPath of such a worktree is a
 *  REMOTE path that does not exist on the Mac, so running fully local would both
 *  crash the spawn and execute bash against a nonexistent local dir.)
 *  Falls back to the explicit `payload.remoteExecHost` override.
 *  Returns host null when this turn should run fully local (no --remote-exec). */
function resolveRemoteExec(
  store: Store | undefined,
  payload: JcodeChatSendPayload
): RemoteExecResolution {
  if (store && typeof payload.worktreeId === 'string') {
    const scope = parseWorkspaceKey(payload.worktreeId)
    if (scope?.type === 'folder') {
      const workspace = store.getFolderWorkspace(scope.folderWorkspaceId)
      // Key off the SSH connection presence: any connectionId-remote worktree
      // (whether or not isRemoteExecOnly was explicitly set) runs brain-local.
      if (workspace?.connectionId) {
        const target = store.getSshTarget(workspace.connectionId)
        // Prefer the OpenSSH config alias so ~/.ssh/config (ProxyJump/identity)
        // applies; fall back to the raw host. jcode resolves the host itself.
        const host = target?.configHost?.trim() || target?.host?.trim()
        if (host) {
          return { host, connectionId: workspace.connectionId }
        }
      }
    }
  }
  return { host: payload.remoteExecHost?.trim() || null, connectionId: null }
}

async function startTurn(
  mainWindow: BrowserWindow,
  store: Store | undefined,
  payload: JcodeChatSendPayload
): Promise<void> {
  const { sessionKey } = payload
  const remote = resolveRemoteExec(store, payload)
  const remoteExecHost = remote.host

  // A fresh turn supersedes any pending Stop bookkeeping for this pane.
  stoppedKeys.delete(sessionKey)

  // Defensive: kill any prior in-flight child for this pane before starting.
  const prior = activeChildren.get(sessionKey)
  if (prior && !prior.killed) {
    try {
      prior.kill()
    } catch {
      // ignore
    }
  }

  // Weave attachments into the prompt (copying local files to the remote host
  // first for remote-exec sessions). Done before spawn so jcode sees the paths.
  let resolvedPrompt: string
  try {
    resolvedPrompt = await resolveTurnPrompt(payload, remote)
  } catch (error) {
    sendEvent(mainWindow, sessionKey, {
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }

  // FEATURE B: prepend a selected skill's SKILL.md body (re-discovered from cwd +
  // worktreeId so remote skills resolve over SSH). Non-fatal if missing.
  resolvedPrompt = await applySkillInjection(
    payload.skillName,
    resolvedPrompt,
    { cwd: payload.cwd, worktreeId: payload.worktreeId },
    store
  )

  // The Node child_process `cwd` MUST be a directory that exists on THIS (local)
  // machine — jcode itself always runs locally, even for brain-local turns. For a
  // remote worktree payload.cwd is the REMOTE project path (e.g. /home/srain/...)
  // which does not exist on the Mac; passing it to spawn() throws `spawn ENOENT`.
  // So for remote turns we anchor the local process at the user's home dir; the
  // remote bash working dir is governed by --remote-exec, not this cwd. Local
  // turns continue to spawn in the worktree's (local) folder path.
  const localSpawnCwd = remoteExecHost ? os.homedir() : payload.cwd?.trim() || undefined

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(JCODE_BIN, buildArgs(payload, remoteExecHost, resolvedPrompt), {
      cwd: localSpawnCwd,
      env: process.env
    })
  } catch (error) {
    sendEvent(mainWindow, sessionKey, {
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }

  activeChildren.set(sessionKey, child)

  // Why: stdout arrives in arbitrary chunks; NDJSON lines can be split across
  // chunks. Buffer the partial trailing line and only parse complete lines.
  let stdoutBuffer = ''
  let stderrBuffer = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    stdoutBuffer += chunk
    let newlineIndex = stdoutBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim()
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
      if (line) {
        try {
          const event = JSON.parse(line) as JcodeNdjsonEvent
          sendEvent(mainWindow, sessionKey, event)
        } catch {
          // Why: non-JSON noise on stdout (banners, etc.) is forwarded as a
          // text_delta so it is visible rather than silently dropped.
          sendEvent(mainWindow, sessionKey, { type: 'text_delta', text: line })
        }
      }
      newlineIndex = stdoutBuffer.indexOf('\n')
    }
  })

  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderrBuffer += chunk
  })

  child.on('error', (error: Error) => {
    activeChildren.delete(sessionKey)
    sendEvent(mainWindow, sessionKey, { type: 'error', error: error.message })
  })

  child.on('close', (code: number | null) => {
    activeChildren.delete(sessionKey)
    const wasStopped = stoppedKeys.delete(sessionKey)
    // Flush any trailing partial line that lacked a newline.
    const trailing = stdoutBuffer.trim()
    if (trailing) {
      try {
        sendEvent(mainWindow, sessionKey, JSON.parse(trailing) as JcodeNdjsonEvent)
      } catch {
        sendEvent(mainWindow, sessionKey, { type: 'text_delta', text: trailing })
      }
    }
    if (wasStopped) {
      // User pressed Stop: a non-zero/kill exit is expected, not an error.
      sendEvent(mainWindow, sessionKey, { type: 'stopped' })
    } else if (code !== 0) {
      sendEvent(mainWindow, sessionKey, {
        type: 'error',
        error:
          stderrBuffer.trim() || `jcode exited with code ${code === null ? 'null' : String(code)}`
      })
    }
    // Always emit a terminal 'exit' so the renderer can finalize UI even when
    // jcode forgot to emit a 'done' (e.g. crash mid-turn).
    sendEvent(mainWindow, sessionKey, { type: 'exit', code })
  })
}

export function registerJcodeChatHandlers(mainWindow: BrowserWindow, store?: Store): void {
  // Re-registration safe (macOS window recreate): drop the previous listener.
  ipcMain.removeAllListeners(JCODE_CHAT_SEND_CHANNEL)
  ipcMain.on(JCODE_CHAT_SEND_CHANNEL, (event, raw: unknown) => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    const payload = raw as JcodeChatSendPayload
    if (!payload || typeof payload.sessionKey !== 'string' || typeof payload.prompt !== 'string') {
      return
    }
    // startTurn is async (it may copy attachments to a remote host before spawn);
    // it reports its own failures as 'error' events, so swallow here.
    void startTurn(mainWindow, store, payload).catch((error) => {
      sendEvent(mainWindow, payload.sessionKey, {
        type: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    })
  })

  // Native multi-select file picker for composer attachments. Returns ABSOLUTE
  // paths (empty array on cancel) so the renderer can show removable chips and
  // the main process can read/copy the files at send time.
  ipcMain.removeHandler(JCODE_CHAT_PICK_FILES_CHANNEL)
  ipcMain.handle(JCODE_CHAT_PICK_FILES_CHANNEL, async (event) => {
    if (event.sender !== mainWindow.webContents) {
      return []
    }
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) {
      return []
    }
    return result.filePaths
  })

  // Stop: kill the in-flight child for a pane. The 'close' handler then emits a
  // 'stopped' event (rather than 'error') because the key is flagged here.
  ipcMain.removeAllListeners(JCODE_CHAT_STOP_CHANNEL)
  ipcMain.on(JCODE_CHAT_STOP_CHANNEL, (event, raw: unknown) => {
    if (event.sender !== mainWindow.webContents) {
      return
    }
    const payload = raw as JcodeChatStopPayload
    if (!payload || typeof payload.sessionKey !== 'string') {
      return
    }
    const child = activeChildren.get(payload.sessionKey)
    if (child && !child.killed) {
      stoppedKeys.add(payload.sessionKey)
      try {
        child.kill()
      } catch {
        stoppedKeys.delete(payload.sessionKey)
      }
    }
  })

  // ─── Durable persistence (BUG 1/2) ──────────────────────────────────────
  // The renderer reduces NDJSON events into full conversation state (messages +
  // tool cards + --resume id) already, so the simplest faithful backing store is
  // to let it send a snapshot on turn boundaries and persist that verbatim. This
  // avoids re-deriving the tool-card shape in main and keeps tool/diff rendering
  // identical after rehydrate.
  ipcMain.removeHandler(JCODE_CHAT_SAVE_CHANNEL)
  ipcMain.handle(JCODE_CHAT_SAVE_CHANNEL, (event, raw: unknown) => {
    if (event.sender !== mainWindow.webContents) {
      return false
    }
    const payload = raw as JcodeChatSavePayload
    if (!payload?.record || typeof payload.record.sessionKey !== 'string') {
      return false
    }
    return saveConversation(payload.record)
  })

  ipcMain.removeHandler(JCODE_CHAT_LIST_CHANNEL)
  ipcMain.handle(JCODE_CHAT_LIST_CHANNEL, (event) => {
    if (event.sender !== mainWindow.webContents) {
      return []
    }
    return listConversations()
  })

  ipcMain.removeHandler(JCODE_CHAT_LOAD_CHANNEL)
  ipcMain.handle(JCODE_CHAT_LOAD_CHANNEL, (event, raw: unknown) => {
    if (event.sender !== mainWindow.webContents) {
      return null
    }
    const sessionKey = typeof raw === 'string' ? raw : (raw as { sessionKey?: string })?.sessionKey
    if (typeof sessionKey !== 'string') {
      return null
    }
    return loadConversation(sessionKey)
  })

  ipcMain.removeHandler(JCODE_CHAT_DELETE_CHANNEL)
  ipcMain.handle(JCODE_CHAT_DELETE_CHANNEL, (event, raw: unknown) => {
    if (event.sender !== mainWindow.webContents) {
      return false
    }
    const sessionKey = typeof raw === 'string' ? raw : (raw as { sessionKey?: string })?.sessionKey
    if (typeof sessionKey !== 'string') {
      return false
    }
    return deleteConversation(sessionKey)
  })

  // FEATURE B: skills-list IPC for the "/" menu (handler + cleanup live in
  // jcode-skills to keep this module under budget).
  registerJcodeSkillsHandler(mainWindow, store)

  mainWindow.on('closed', () => {
    for (const child of activeChildren.values()) {
      if (!child.killed) {
        try {
          child.kill()
        } catch {
          // ignore
        }
      }
    }
    activeChildren.clear()
    stoppedKeys.clear()
    ipcMain.removeAllListeners(JCODE_CHAT_SEND_CHANNEL)
    ipcMain.removeAllListeners(JCODE_CHAT_STOP_CHANNEL)
    ipcMain.removeHandler(JCODE_CHAT_PICK_FILES_CHANNEL)
    ipcMain.removeHandler(JCODE_CHAT_SAVE_CHANNEL)
    ipcMain.removeHandler(JCODE_CHAT_LIST_CHANNEL)
    ipcMain.removeHandler(JCODE_CHAT_LOAD_CHANNEL)
    ipcMain.removeHandler(JCODE_CHAT_DELETE_CHANNEL)
  })
}
