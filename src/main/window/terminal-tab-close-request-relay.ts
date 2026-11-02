import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  TerminalTabCloseRequest,
  TerminalTabCloseResponse
} from '../../shared/terminal-tab-close'
import { addFanoutListener, addFanoutListeners } from '../event-listener-fanout'

const TERMINAL_TAB_CLOSE_TIMEOUT_MS = 20_000

export async function requestTerminalTabCloseFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string,
  options: { localPtyTeardownOwnedExternally?: boolean; force?: boolean } = {}
): Promise<void> {
  if (mainWindow.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const webContents = mainWindow.webContents
  if (webContents.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const releaseListeners: (() => void)[] = []
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      for (const release of releaseListeners) {
        release()
      }
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const timeout = setTimeout(
      () => finish(new Error('terminal_tab_close_timeout')),
      TERMINAL_TAB_CLOSE_TIMEOUT_MS
    )
    const onResponse = (event: Electron.IpcMainEvent, response: TerminalTabCloseResponse): void => {
      // Visible request IDs confer no authority; only the selected window may commit/reject its lifecycle transaction.
      if (event.sender !== webContents || response.requestId !== requestId) {
        return
      }
      if (response.error) {
        finish(new Error(response.error))
      } else {
        finish()
      }
    }
    releaseListeners.push(addFanoutListener(ipcMain, 'ui:terminalTabCloseResponse', onResponse))
    // Lean test windows may lack event methods.
    if (typeof mainWindow.on === 'function') {
      releaseListeners.push(addFanoutListener(mainWindow, 'closed', onRendererUnavailable))
    }
    if (typeof webContents.on === 'function') {
      releaseListeners.push(
        addFanoutListeners(webContents, ['destroyed', 'render-process-gone'], onRendererUnavailable)
      )
    }
    const request: TerminalTabCloseRequest = { requestId, tabId, ...options }
    try {
      webContents.send('ui:terminalTabCloseRequest', request)
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
