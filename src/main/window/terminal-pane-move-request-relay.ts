import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  TerminalLeafMoveResult,
  TerminalPaneMoveToNewTabReply,
  TerminalPaneMoveToNewTabRequest
} from '../../shared/workspace-layout/terminal-topology/terminal-leaf-move'
import { addFanoutListener } from '../runtime/events/event-listener-fanout'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'
import { holdRelayedPaneMove, type RelayedPaneMove } from './terminal-pane-move-commit-fence'

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
    let released = false
    const releaseListeners: (() => void)[] = []
    const settle = (error: Error | null, result?: TerminalLeafMoveResult): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
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
      for (const releaseListener of releaseListeners) {
        releaseListener()
      }
    }
    let committed: Promise<unknown> | null = null
    const relayed: RelayedPaneMove = {
      sender: webContents,
      timedOut: false,
      claim: (commit) => {
        clearTimeout(timeout)
        committed = commit
      },
      answer: (result) => settle(null, result)
    }
    const unfence = holdRelayedPaneMove(move.targetTabId, relayed)
    if (!unfence) {
      // Why: replacing a still-fenced move would let its late commit answer this one.
      reject(new Error('terminal_pane_move_in_progress'))
      return
    }
    releaseListeners.push(unfence)
    const onRendererUnavailable = (): void => {
      release()
      // A claimed commit still lands in main, so a moved pane is answered by its commit.
      const refuse = (): void => settle(new Error('renderer_unavailable'))
      if (committed) {
        void committed.then(refuse, refuse)
      } else {
        refuse()
      }
    }
    // The client hears a refusal now; the move stays fenced until the window answers or goes away.
    const timeout = setTimeout(() => {
      relayed.timedOut = true
      settle(new Error('terminal_pane_move_timeout'))
    }, TERMINAL_PANE_MOVE_TIMEOUT_MS)
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
