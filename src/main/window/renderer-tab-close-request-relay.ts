import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  SessionTabCloseRequest,
  SessionTabCloseResponse,
  SessionTabCloseResult,
  TerminalTabCloseRequest,
  TerminalTabCloseResponse
} from '../../shared/terminal-tab-close'

const TAB_CLOSE_TIMEOUT_MS = 20_000

export async function requestTerminalTabCloseFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string
): Promise<void> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener('ui:terminalTabCloseResponse', onResponse)
      reject(new Error('terminal_tab_close_timeout'))
    }, TAB_CLOSE_TIMEOUT_MS)
    const onResponse = (event: Electron.IpcMainEvent, response: TerminalTabCloseResponse): void => {
      // Why: request IDs are visible to renderer code; only the selected main window may commit or reject its lifecycle transaction.
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
    const request: TerminalTabCloseRequest = { requestId, tabId }
    mainWindow.webContents.send('ui:terminalTabCloseRequest', request)
  })
}

export async function requestSessionTabCloseFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string,
  worktreeId: string
): Promise<SessionTabCloseResult> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const requestId = randomUUID()
  return new Promise<SessionTabCloseResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener('ui:sessionTabCloseResponse', onResponse)
      reject(new Error('session_tab_close_timeout'))
    }, TAB_CLOSE_TIMEOUT_MS)
    const onResponse = (event: Electron.IpcMainEvent, response: SessionTabCloseResponse): void => {
      if (event.sender !== mainWindow.webContents || response.requestId !== requestId) {
        return
      }
      clearTimeout(timeout)
      ipcMain.removeListener('ui:sessionTabCloseResponse', onResponse)
      if (response.error || !response.result) {
        reject(new Error(response.error ?? 'session_tab_close_failed'))
      } else {
        resolve(response.result)
      }
    }
    ipcMain.on('ui:sessionTabCloseResponse', onResponse)
    const request: SessionTabCloseRequest = { requestId, tabId, worktreeId }
    mainWindow.webContents.send('ui:sessionTabCloseRequest', request)
  })
}
