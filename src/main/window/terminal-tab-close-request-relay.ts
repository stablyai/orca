import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { TERMINAL_TAB_CLOSE_RENDERER_TIMEOUT_MS } from '../../shared/terminal-tab-close'
import type {
  TerminalTabCloseRequest,
  TerminalTabCloseResponse
} from '../../shared/terminal-tab-close'

export async function requestTerminalTabCloseFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string,
  options?: { validateOnly?: boolean; expectedPtyIds?: string[] }
): Promise<void> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener('ui:terminalTabCloseResponse', onResponse)
      reject(new Error('terminal_tab_close_timeout'))
    }, TERMINAL_TAB_CLOSE_RENDERER_TIMEOUT_MS)
    const onResponse = (event: Electron.IpcMainEvent, response: TerminalTabCloseResponse): void => {
      // Why: request IDs are visible to renderer code; only the selected main
      // window may commit or reject its lifecycle transaction.
      if (event.sender !== mainWindow.webContents || response.requestId !== requestId) {
        return
      }
      clearTimeout(timeout)
      ipcMain.removeListener('ui:terminalTabCloseResponse', onResponse)
      if (response.error) {
        reject(new Error(response.error))
      } else {
        resolve()
      }
    }
    ipcMain.on('ui:terminalTabCloseResponse', onResponse)
    const request: TerminalTabCloseRequest = { requestId, tabId, ...options }
    mainWindow.webContents.send('ui:terminalTabCloseRequest', request)
  })
}
