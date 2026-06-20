// Why: jcode's chat-bubble view (M1) needs CLEAN newline-delimited JSON on
// stdout, so it is spawned with node child_process — NOT a PTY. A PTY would
// inject terminal control sequences and line-wrapping that corrupt the JSON
// stream. Each `jcode run ... --ndjson <prompt>` invocation is one-shot: it
// emits NDJSON then exits. Conversations continue via --resume <sessionId>,
// captured from the 'start'/'done' events on a previous turn.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { type BrowserWindow, ipcMain } from 'electron'
import {
  JCODE_CHAT_EVENT_CHANNEL,
  JCODE_CHAT_SEND_CHANNEL,
  type JcodeChatSendPayload,
  type JcodeNdjsonEvent
} from '../../shared/jcode-chat-types'

// Why: jcode is installed via cargo; the absolute path avoids depending on the
// (often empty under Electron) PATH. Mirrors the pinned tool path the desktop
// prototype and CLI verification use.
const JCODE_BIN = '/Users/vinny/.cargo/bin/jcode'

/** One in-flight turn per sessionKey. A new send for the same key cancels the
 *  previous child first (defensive — the renderer should not double-send). */
const activeChildren = new Map<string, ChildProcessWithoutNullStreams>()

function sendEvent(mainWindow: BrowserWindow, sessionKey: string, event: JcodeNdjsonEvent): void {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return
  }
  mainWindow.webContents.send(JCODE_CHAT_EVENT_CHANNEL, { sessionKey, event })
}

function buildArgs(payload: JcodeChatSendPayload): string[] {
  const provider = payload.provider?.trim() || 'openai'
  const args = ['run', '-p', provider]
  if (payload.model?.trim()) {
    args.push('-m', payload.model.trim())
  }
  if (payload.cwd?.trim()) {
    args.push('-C', payload.cwd.trim())
  }
  if (payload.resumeSessionId?.trim()) {
    args.push('--resume', payload.resumeSessionId.trim())
  }
  // brain-local (M3): unused until then, but wired so the chat path needs no
  // further changes when remote-exec lands.
  if (payload.remoteExecHost?.trim()) {
    args.push('--remote-exec', payload.remoteExecHost.trim())
  }
  args.push('--ndjson', payload.prompt)
  return args
}

function startTurn(mainWindow: BrowserWindow, payload: JcodeChatSendPayload): void {
  const { sessionKey } = payload

  // Defensive: kill any prior in-flight child for this pane before starting.
  const prior = activeChildren.get(sessionKey)
  if (prior && !prior.killed) {
    try {
      prior.kill()
    } catch {
      // ignore
    }
  }

  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(JCODE_BIN, buildArgs(payload), {
      cwd: payload.cwd?.trim() || undefined,
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
    // Flush any trailing partial line that lacked a newline.
    const trailing = stdoutBuffer.trim()
    if (trailing) {
      try {
        sendEvent(mainWindow, sessionKey, JSON.parse(trailing) as JcodeNdjsonEvent)
      } catch {
        sendEvent(mainWindow, sessionKey, { type: 'text_delta', text: trailing })
      }
    }
    if (code !== 0) {
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

export function registerJcodeChatHandlers(mainWindow: BrowserWindow): void {
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
    startTurn(mainWindow, payload)
  })

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
    ipcMain.removeAllListeners(JCODE_CHAT_SEND_CHANNEL)
  })
}
