import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  SessionTabCloseRequest,
  SessionTabCloseResponse
} from '../../shared/session-tab-close'
import { SESSION_TAB_CLOSE_TIMEOUT_ERROR } from '../../shared/session-tab-close'

const SESSION_TAB_CLOSE_CONFIRMATION_MS = 5 * 60_000
const SESSION_TAB_CLOSE_RESPONSE_GRACE_MS = 5_000

export async function requestSessionTabCloseFromRenderer(
  mainWindow: BrowserWindow,
  tabId: string,
  worktreeId: string
): Promise<void> {
  if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const webContents = mainWindow.webContents
  const requestId = randomUUID()
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener('ui:sessionTabCloseResponse', onResponse)
      mainWindow.removeListener('closed', onRendererUnavailable)
      webContents.removeListener('destroyed', onRendererUnavailable)
      webContents.removeListener('render-process-gone', onRendererUnavailable)
      webContents.removeListener('did-start-loading', onRendererUnavailable)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const onResponse = (event: Electron.IpcMainEvent, response: SessionTabCloseResponse): void => {
      if (event.sender !== webContents || response.requestId !== requestId) {
        return
      }
      finish(response.error ? new Error(response.error) : undefined)
    }
    const expiresAt = Date.now() + SESSION_TAB_CLOSE_CONFIRMATION_MS
    const timeout = setTimeout(
      () => finish(new Error(SESSION_TAB_CLOSE_TIMEOUT_ERROR)),
      SESSION_TAB_CLOSE_CONFIRMATION_MS + SESSION_TAB_CLOSE_RESPONSE_GRACE_MS
    )
    timeout.unref?.()
    ipcMain.on('ui:sessionTabCloseResponse', onResponse)
    mainWindow.once('closed', onRendererUnavailable)
    webContents.once('destroyed', onRendererUnavailable)
    webContents.once('render-process-gone', onRendererUnavailable)
    webContents.once('did-start-loading', onRendererUnavailable)
    const request: SessionTabCloseRequest = { requestId, tabId, worktreeId, expiresAt }
    try {
      webContents.send('ui:sessionTabCloseRequest', request)
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
