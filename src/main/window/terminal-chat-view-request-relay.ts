import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { RuntimeSessionTabChatView } from '../../shared/runtime-session-contracts'
import {
  TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR,
  type TerminalChatViewRequest,
  type TerminalChatViewResponse
} from '../../shared/terminal-chat-view-request'

// Why 10 s: below every client's own timeout, so a slow renderer surfaces as delivery-unknown.
const TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_MS = 10_000

/**
 * Asks the renderer, which owns a desktop host's tabs, to apply a chat pair and reply with the
 * pair it holds. The send happens synchronously in this call so IPC order equals call order.
 */
export function requestTerminalChatViewFromRenderer(
  mainWindow: BrowserWindow,
  args: Omit<TerminalChatViewRequest, 'requestId'>
): Promise<RuntimeSessionTabChatView> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return Promise.reject(new Error('renderer_unavailable'))
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  return new Promise<RuntimeSessionTabChatView>((resolve, reject) => {
    let settled = false
    const finish = (result: { chatView: RuntimeSessionTabChatView } | { error: Error }): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener('ui:terminalChatViewResponse', onResponse)
      mainWindow.removeListener('closed', onRendererUnavailable)
      webContents.removeListener('destroyed', onRendererUnavailable)
      webContents.removeListener('render-process-gone', onRendererUnavailable)
      webContents.removeListener('did-start-loading', onRendererUnavailable)
      if ('error' in result) {
        reject(result.error)
      } else {
        resolve(result.chatView)
      }
    }
    const onRendererUnavailable = (): void => finish({ error: new Error('renderer_unavailable') })
    const onResponse = (event: Electron.IpcMainEvent, response: TerminalChatViewResponse): void => {
      if (event.sender !== webContents || response.requestId !== requestId) {
        return
      }
      finish(
        response.chatView && !response.error
          ? { chatView: response.chatView }
          : { error: new Error(response.error ?? 'chat_view_reply_missing') }
      )
    }
    const timeout = setTimeout(
      () => finish({ error: new Error(TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_ERROR) }),
      TERMINAL_CHAT_VIEW_RELAY_TIMEOUT_MS
    )
    timeout.unref?.()
    ipcMain.on('ui:terminalChatViewResponse', onResponse)
    mainWindow.once('closed', onRendererUnavailable)
    webContents.once('destroyed', onRendererUnavailable)
    webContents.once('render-process-gone', onRendererUnavailable)
    webContents.once('did-start-loading', onRendererUnavailable)
    const request: TerminalChatViewRequest = { requestId, ...args }
    try {
      webContents.send('ui:terminalChatViewRequest', request)
    } catch {
      finish({ error: new Error('renderer_unavailable') })
    }
  })
}
