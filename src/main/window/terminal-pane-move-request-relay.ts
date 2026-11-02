import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  TerminalLeafMoveResult,
  TerminalPaneMoveToNewTabReply,
  TerminalPaneMoveToNewTabRequest
} from '../../shared/workspace-layout/terminal-leaf-move'
import { addFanoutListener } from '../runtime/events/event-listener-fanout'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { fenceRelayedPaneMove, trackRelayedPaneMove } from './terminal-pane-move-commit-fence'

// Why: under the client's 15s call timeout, so the client hears an answer rather than losing the reply.
const TERMINAL_PANE_MOVE_TIMEOUT_MS = 10_000

/**
 * Asks the window to move a pane to a new tab. The window's reply answers the client. Without one,
 * by the deadline or because the window went away, a move the window committed answers with its
 * commit, and an uncommitted one rejects and, past the deadline, can no longer commit.
 */
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
    let released = false
    let committed: Promise<TerminalLeafMoveResult> | null = null
    const releaseListeners: (() => void)[] = []
    const settle = (error: Error | null, result?: TerminalLeafMoveResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (error || !result) {
        reject(error ?? new Error('terminal_pane_move_failed'))
      } else {
        resolve(result)
      }
    }
    const release = (): void => {
      if (released) {
        return
      }
      released = true
      clearTimeout(timeout)
      for (const releaseListener of releaseListeners) {
        releaseListener()
      }
    }
    const endWithoutReply = (error: Error, fenceUncommitted: boolean): void => {
      if (committed) {
        committed.then(
          (result) => settle(null, result),
          (commitError: unknown) =>
            settle(commitError instanceof Error ? commitError : new Error(String(commitError)))
        )
      } else {
        if (fenceUncommitted) {
          fenceRelayedPaneMove(webContents, move.targetTabId)
        }
        settle(error)
      }
      release()
    }
    const onRendererUnavailable = (): void =>
      endWithoutReply(new Error('renderer_unavailable'), false)
    const timeout = setTimeout(
      () => endWithoutReply(new Error('terminal_pane_move_timeout'), true),
      TERMINAL_PANE_MOVE_TIMEOUT_MS
    )
    const onReply = (event: Electron.IpcMainEvent, reply: TerminalPaneMoveToNewTabReply): void => {
      // Visible request IDs confer no authority; only the targeted window can answer.
      if (event.sender !== webContents || reply?.requestId !== requestId) {
        return
      }
      settle(null, reply.result)
      release()
    }
    const lifetime = abortWhenRendererGone(webContents)
    lifetime.signal.addEventListener('abort', onRendererUnavailable, { once: true })
    releaseListeners.push(
      trackRelayedPaneMove(webContents, move.targetTabId, (commit) => {
        committed = commit
      }),
      lifetime.dispose,
      () => lifetime.signal.removeEventListener('abort', onRendererUnavailable),
      addFanoutListener(mainWindow, 'closed', onRendererUnavailable),
      addFanoutListener(ipcMain, 'ui:terminalPaneMoveToNewTabReply', onReply)
    )
    const request: TerminalPaneMoveToNewTabRequest = { ...move, requestId }
    try {
      webContents.send('ui:terminalPaneMoveToNewTabRequest', request)
    } catch {
      onRendererUnavailable()
    }
  })
}
