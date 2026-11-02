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

/**
 * Asks the window that owns the layout to change what one tab holds, and waits for its answer:
 * whether the tab now holds the content. A window that never got the request changed nothing; one
 * that didn't answer may have.
 */
export function requestTabContentFromRenderer(
  mainWindow: BrowserWindow,
  request: Omit<WindowTabContentRequest, 'requestId'>
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
    const timeout = setTimeout(
      () => finish(new TerminalRevealUnconfirmedError('Tab content change timed out')),
      TAB_CONTENT_REPLY_MS
    )
    releaseListeners.push(
      addFanoutListener(ipcMain, 'ui:tabContentReply', onReply),
      addFanoutListener(mainWindow, 'closed', onGone),
      addFanoutListeners(webContents, ['destroyed', 'render-process-gone'], onGone)
    )
    try {
      webContents.send('ui:setTabContent', { ...request, requestId })
    } catch {
      finish(new TerminalNotPlacedError('renderer_unavailable'))
    }
  })
}
