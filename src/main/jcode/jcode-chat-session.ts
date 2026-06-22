// Why: chat bubbles need clean NDJSON stdout, so jcode runs as child_process,
// not a PTY. Each turn is one-shot; conversation continuity uses --resume.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import os from 'node:os'
import { type BrowserWindow, dialog, ipcMain } from 'electron'
import type { Store } from '../persistence'
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
import {
  cleanupRemoteAttachmentDir,
  resolveTurnPrompt,
  extractImagePaths,
  nonImageAttachments
} from './jcode-attachments'
import { resolveJcodeBin } from './jcode-binary'
import { friendlyChildError } from './jcode-error-messages'
import { resolveRemoteExec } from './jcode-remote-exec'
import { applySkillInjection, registerJcodeSkillsHandler } from './jcode-skills'

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
  resolvedPrompt: string,
  remotePath: string | null,
  imagePaths: string[]
): string[] {
  // Custom profiles imply openai-compatible; passing both profile and -p would
  // be ambiguous. `-m model` still overrides the profile default.
  const profile = payload.providerProfile?.trim()
  // "auto" matches the composer chip; concrete ids are used only when selected.
  const args = profile
    ? ['run', '--provider-profile', profile]
    : ['run', '-p', payload.provider?.trim() || 'auto']
  if (payload.model?.trim()) {
    args.push('-m', payload.model.trim())
  }
  // Under --remote-exec, -C seeds the remote session working_dir instead of
  // chdiring locally. Local turns keep using the local project path.
  if (remoteExecHost && remotePath?.trim()) {
    args.push('-C', remotePath.trim())
  } else if (!remoteExecHost && payload.cwd?.trim()) {
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
  // Vision: image attachments are read LOCALLY by jcode and sent as image content
  // blocks. Options must precede the positional <MESSAGE>, so push before --ndjson.
  args.push(...imagePaths.flatMap((imagePath) => ['--image', imagePath]))
  args.push('--ndjson', resolvedPrompt)
  return args
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

  // Vision: pull out image attachments — they ride `--image` (read LOCALLY by
  // jcode, even under --remote-exec) instead of being woven into the prompt or
  // copied to the remote host. Everything else still gets woven.
  const allAttachments = payload.attachments ?? []
  const imagePaths = extractImagePaths(allAttachments)
  const promptPayload =
    imagePaths.length > 0
      ? { ...payload, attachments: nonImageAttachments(allAttachments) }
      : payload

  // Weave non-image attachments into the prompt; remote turns may upload files first.
  let resolvedPrompt: string
  let attachmentCleanup: { connectionId: string; remoteDir: string } | null = null
  try {
    const turnPrompt = await resolveTurnPrompt(promptPayload, remote)
    resolvedPrompt = turnPrompt.prompt
    attachmentCleanup = turnPrompt.cleanup
  } catch (error) {
    sendEvent(mainWindow, sessionKey, {
      type: 'error',
      error: error instanceof Error ? error.message : String(error)
    })
    return
  }

  // If the user attached only image(s) with no typed text, give the model a
  // default instruction so the positional message isn't empty.
  if (imagePaths.length > 0 && !resolvedPrompt.trim()) {
    resolvedPrompt = 'Describe the attached image(s).'
  }

  resolvedPrompt = await applySkillInjection(
    payload.skillName,
    resolvedPrompt,
    { cwd: payload.cwd, worktreeId: payload.worktreeId },
    store
  )

  // jcode runs locally even for brain-local turns, so remote worktrees must not
  // become spawn cwd; --remote-exec owns the remote bash working directory.
  const localSpawnCwd = remoteExecHost ? os.homedir() : payload.cwd?.trim() || undefined

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(
      resolveJcodeBin(),
      buildArgs(payload, remoteExecHost, resolvedPrompt, remote.remotePath, imagePaths),
      {
        cwd: localSpawnCwd,
        env: process.env
      }
    )
  } catch (error) {
    void cleanupRemoteAttachmentDir(attachmentCleanup?.connectionId, attachmentCleanup?.remoteDir)
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
          sendEvent(mainWindow, sessionKey, JSON.parse(line) as JcodeNdjsonEvent)
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
    sendEvent(mainWindow, sessionKey, {
      type: 'error',
      error: friendlyChildError(error.message, remoteExecHost)
    })
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
      const raw =
        stderrBuffer.trim() || `jcode exited with code ${code === null ? 'null' : String(code)}`
      sendEvent(mainWindow, sessionKey, {
        type: 'error',
        error: friendlyChildError(raw, remoteExecHost)
      })
    }
    // Always emit a terminal 'exit' so the renderer can finalize UI even when
    // jcode forgot to emit a 'done' (e.g. crash mid-turn).
    sendEvent(mainWindow, sessionKey, { type: 'exit', code })
    void cleanupRemoteAttachmentDir(attachmentCleanup?.connectionId, attachmentCleanup?.remoteDir)
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

  // Renderer snapshots are already the conversation truth, including tool cards.
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
