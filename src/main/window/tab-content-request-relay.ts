import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  WindowTabContentOutcome,
  WindowTabContentReply,
  WindowTabContentRequest
} from '../../shared/window-tab-content'
import {
  TerminalNotPlacedError,
  TerminalRevealUnconfirmedError
} from '../runtime/session-tabs/terminal-not-placed-error'
import { addFanoutListener, addFanoutListeners } from '../event-listener-fanout'

const TAB_CONTENT_REPLY_MS = 10_000
// The window refuses at the deadline and answers in the same task it applies in, so a reply not
// here by then plus this grace means it changed nothing.
const TAB_CONTENT_REPLY_GRACE_MS = 2_000

/**
 * Asks the window that owns the layout to change what one tab holds (or which tab it would), and
 * waits for its answer: whether the tab now holds the content. No answer by the deadline means the
 * window refused it; only a window that died meanwhile leaves that unknown.
 */
export function requestTabContentFromRenderer(
  mainWindow: BrowserWindow,
  request: Omit<WindowTabContentRequest, 'requestId' | 'expiresAt'>
): Promise<WindowTabContentOutcome> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new TerminalNotPlacedError('renderer_unavailable'))
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    const releaseListeners: (() => void)[] = []
    const finish = (outcome: WindowTabContentOutcome | Error): void => {
      clearTimeout(timeout)
      for (const release of releaseListeners.splice(0)) {
        release()
      }
      if (outcome instanceof Error) {
        reject(outcome)
      } else {
        resolve(outcome)
      }
    }
    const onReply = (event: Electron.IpcMainEvent, reply: WindowTabContentReply): void => {
      // Renderer-supplied request ids confer no authority; only this window answers.
      if (event.sender !== webContents || reply.requestId !== requestId) {
        return
      }
      finish(
        reply.error
          ? new TerminalRevealUnconfirmedError(reply.error)
          : { retargeted: reply.retargeted, ...(reply.tabId ? { tabId: reply.tabId } : {}) }
      )
    }
    const onGone = (): void => finish(new TerminalRevealUnconfirmedError('renderer_unavailable'))
    const expiresAt = Date.now() + TAB_CONTENT_REPLY_MS
    const timeout = setTimeout(
      () => finish(new TerminalNotPlacedError('Tab content change timed out')),
      TAB_CONTENT_REPLY_MS + TAB_CONTENT_REPLY_GRACE_MS
    )
    releaseListeners.push(
      addFanoutListener(ipcMain, 'ui:tabContentReply', onReply),
      addFanoutListener(mainWindow, 'closed', onGone),
      addFanoutListeners(webContents, ['destroyed', 'render-process-gone'], onGone)
    )
    try {
      webContents.send('ui:setTabContent', { ...request, requestId, expiresAt })
    } catch {
      finish(new TerminalNotPlacedError('renderer_unavailable'))
    }
  })
}
