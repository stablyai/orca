import { randomUUID } from 'node:crypto'

import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import type {
  RuntimeMarkdownReadTabResult,
  RuntimeMarkdownSaveTabResult,
  RuntimeMobileMarkdownRequest,
  RuntimeMobileMarkdownResponse
} from '../../shared/mobile-markdown-document'

const MOBILE_MARKDOWN_RENDERER_TIMEOUT_MS = 20_000

type RendererMobileMarkdownRequest = RuntimeMobileMarkdownRequest extends infer Request
  ? Request extends { id: string }
    ? Omit<Request, 'id'>
    : never
  : never

export async function requestMobileMarkdownFromRenderer(
  mainWindow: BrowserWindow,
  request: RendererMobileMarkdownRequest
): Promise<RuntimeMarkdownReadTabResult | RuntimeMarkdownSaveTabResult> {
  if (mainWindow.isDestroyed()) {
    throw new Error('renderer_unavailable')
  }
  const webContents = mainWindow.webContents
  const id = randomUUID()
  return await new Promise((resolve, reject) => {
    let settled = false
    const onRendererUnavailable = (): void => finish(new Error('renderer_unavailable'))
    const finish = (
      error?: Error,
      result?: RuntimeMarkdownReadTabResult | RuntimeMarkdownSaveTabResult
    ): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      ipcMain.removeListener('ui:mobileMarkdownResponse', onResponse)
      if (typeof mainWindow.removeListener === 'function') {
        mainWindow.removeListener('closed', onRendererUnavailable)
      }
      if (typeof webContents.removeListener === 'function') {
        webContents.removeListener('destroyed', onRendererUnavailable)
        webContents.removeListener('render-process-gone', onRendererUnavailable)
      }
      if (error) {
        reject(error)
      } else if (result) {
        resolve(result)
      } else {
        reject(new Error('renderer_unavailable'))
      }
    }
    const timeout = setTimeout(
      () => finish(new Error('renderer_timeout')),
      MOBILE_MARKDOWN_RENDERER_TIMEOUT_MS
    )
    const onResponse = (
      event: Electron.IpcMainEvent,
      response: RuntimeMobileMarkdownResponse
    ): void => {
      if (mainWindow.isDestroyed() || event.sender !== webContents) {
        return
      }
      if (response.id !== id) {
        return
      }
      if (response.ok) {
        finish(undefined, response.result)
      } else {
        finish(new Error(response.error))
      }
    }
    ipcMain.on('ui:mobileMarkdownResponse', onResponse)
    if (typeof mainWindow.once === 'function') {
      mainWindow.once('closed', onRendererUnavailable)
    }
    if (typeof webContents.once === 'function') {
      webContents.once('destroyed', onRendererUnavailable)
      webContents.once('render-process-gone', onRendererUnavailable)
    }
    try {
      webContents.send('ui:mobileMarkdownRequest', { id, ...request })
    } catch {
      finish(new Error('renderer_unavailable'))
    }
  })
}
