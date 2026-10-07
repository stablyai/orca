import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'

const SESSION_TAB_PROPS_TIMEOUT_MS = 10_000

export type SessionTabPropsWindow = Pick<
  BrowserWindow,
  'isDestroyed' | 'once' | 'removeListener'
> & {
  webContents: Pick<
    BrowserWindow['webContents'],
    'isDestroyed' | 'send' | 'once' | 'removeListener'
  >
}

export async function requestSessionTabPropsFromRenderer(
  mainWindow: SessionTabPropsWindow,
  tabId: string,
  worktreeId: string,
  props: { color?: string | null; isPinned?: boolean; viewMode?: 'terminal' | 'chat' }
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
      ipcMain.removeListener('ui:sessionTabPropsResponse', onResponse)
      mainWindow.removeListener('closed', onRendererUnavailable)
      webContents.removeListener('destroyed', onRendererUnavailable)
      webContents.removeListener('render-process-gone', onRendererUnavailable)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const onResponse = (
      event: Electron.IpcMainEvent,
      response: { requestId: string; error?: string }
    ): void => {
      if (event.sender !== webContents || response.requestId !== requestId) {
        return
      }
      finish(response.error ? new Error(response.error) : undefined)
    }
    const timeout = setTimeout(
      () => finish(new Error('renderer_timeout')),
      SESSION_TAB_PROPS_TIMEOUT_MS
    )
    timeout.unref?.()
    ipcMain.on('ui:sessionTabPropsResponse', onResponse)
    mainWindow.once('closed', onRendererUnavailable)
    webContents.once('destroyed', onRendererUnavailable)
    webContents.once('render-process-gone', onRendererUnavailable)
    try {
      webContents.send('ui:sessionTabPropsRequest', { requestId, tabId, worktreeId, ...props })
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
