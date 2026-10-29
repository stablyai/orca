import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  TerminalLeafMoveResult,
  TerminalPaneMoveToNewTabReply,
  TerminalPaneMoveToNewTabRequest
} from '../../shared/terminal-leaf-move'
import { addFanoutListener } from '../event-listener-fanout'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'

// Why: under the client's 15s call timeout, so the client hears a refusal rather than losing the reply.
const TERMINAL_PANE_MOVE_TIMEOUT_MS = 10_000

/** Asks the window to move a pane to a new tab; rejects when the window cannot answer. */
export function requestTerminalPaneMoveFromRenderer(
  mainWindow: BrowserWindow,
  move: Omit<TerminalPaneMoveToNewTabRequest, 'requestId'>
): Promise<TerminalLeafMoveResult> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise<TerminalLeafMoveResult>((resolve, reject) => {
    let settled = false
    const releaseListeners: (() => void)[] = []
    const finish = (error: Error | null, result?: TerminalLeafMoveResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      for (const release of releaseListeners) {
        release()
      }
      if (error || !result) {
        reject(error ?? new Error('terminal_pane_move_failed'))
      } else {
        resolve(result)
      }
    }
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const timeout = setTimeout(
      () => finish(new Error('terminal_pane_move_timeout')),
      TERMINAL_PANE_MOVE_TIMEOUT_MS
    )
    const onReply = (event: Electron.IpcMainEvent, reply: TerminalPaneMoveToNewTabReply): void => {
      // Visible request IDs confer no authority; only the targeted window can answer.
      if (event.sender !== webContents || reply?.requestId !== requestId) {
        return
      }
      finish(null, reply.result)
    }
    const lifetime = abortWhenRendererGone(webContents)
    lifetime.signal.addEventListener('abort', onRendererUnavailable, { once: true })
    releaseListeners.push(
      lifetime.dispose,
      () => lifetime.signal.removeEventListener('abort', onRendererUnavailable),
      addFanoutListener(mainWindow, 'closed', onRendererUnavailable),
      addFanoutListener(ipcMain, 'ui:terminalPaneMoveToNewTabReply', onReply)
    )
    const request: TerminalPaneMoveToNewTabRequest = { ...move, requestId }
    try {
      webContents.send('ui:terminalPaneMoveToNewTabRequest', request)
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
