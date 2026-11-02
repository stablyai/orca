import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import type {
  TerminalLeafMoveResult,
  TerminalPaneMoveToNewTabReply,
  TerminalPaneMoveToNewTabRequest
} from '../../shared/workspace-layout/terminal-leaf-move'
import { addFanoutListener } from '../runtime/events/event-listener-fanout'
import { abortWhenRendererGone } from '../ipc/renderer-lifetime-abort'

// Why: under the client's 15s call timeout, so the client hears a refusal rather than losing the reply.
const TERMINAL_PANE_MOVE_TIMEOUT_MS = 10_000

type RelayedPaneMove = {
  webContents: WebContents
  timedOut: boolean
  /** The window is committing, so the deadline can no longer turn the move into a refusal. */
  claim: () => void
}

/** Client moves a window is still carrying out, by the new tab's id. */
const relayedPaneMoves = new Map<string, RelayedPaneMove>()

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
      if (relayedPaneMoves.get(move.targetTabId) === relayed) {
        relayedPaneMoves.delete(move.targetTabId)
      }
      for (const releaseListener of releaseListeners) {
        releaseListener()
      }
    }
    const relayed: RelayedPaneMove = {
      webContents,
      timedOut: false,
      claim: () => clearTimeout(timeout)
    }
    const onRendererUnavailable = (): void => {
      settle(new Error('renderer_unavailable'))
      release()
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
    relayedPaneMoves.set(move.targetTabId, relayed)
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

/**
 * Commits a window's pane move. A move a client asked for commits nothing once the client was told
 * it timed out; once committing, the client waits for the window's final reply, not the deadline.
 */
export async function commitRelayedPaneMove(
  sender: WebContents,
  targetTabId: string,
  commit: () => Promise<TerminalLeafMoveResult>
): Promise<TerminalLeafMoveResult> {
  const relayed = relayedPaneMoves.get(targetTabId)
  if (!relayed || relayed.webContents !== sender) {
    return commit()
  }
  if (relayed.timedOut) {
    return { status: 'refused', reason: 'pane_unavailable' }
  }
  relayed.claim()
  return commit()
}
