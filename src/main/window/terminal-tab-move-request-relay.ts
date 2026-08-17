import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type { TerminalTabMoveRequest, TerminalTabMoveResponse } from '../../shared/terminal-tab-move'

const TERMINAL_TAB_MOVE_TIMEOUT_MS = 20_000

export async function requestTerminalTabMoveFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string,
  destWorktreeId: string
): Promise<void> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener('ui:terminalTabMoveResponse', onResponse)
      reject(new Error('terminal_tab_move_timeout'))
    }, TERMINAL_TAB_MOVE_TIMEOUT_MS)
    const onResponse = (event: Electron.IpcMainEvent, response: TerminalTabMoveResponse): void => {
      if (event.sender !== mainWindow.webContents || response.requestId !== requestId) {
        return
      }
      clearTimeout(timeout)
      ipcMain.removeListener('ui:terminalTabMoveResponse', onResponse)
      if (response.error) {
        reject(new Error(response.error))
      } else {
        resolve()
      }
    }
    ipcMain.on('ui:terminalTabMoveResponse', onResponse)
    const request: TerminalTabMoveRequest = { requestId, tabId, destWorktreeId }
    mainWindow.webContents.send('ui:terminalTabMoveRequest', request)
  })
}
