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
  const id = randomUUID()
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ipcMain.removeListener('ui:mobileMarkdownResponse', onResponse)
      reject(new Error('renderer_timeout'))
    }, MOBILE_MARKDOWN_RENDERER_TIMEOUT_MS)
    const onResponse = (
      event: Electron.IpcMainEvent,
      response: RuntimeMobileMarkdownResponse
    ): void => {
      if (event.sender !== mainWindow.webContents) {
        return
      }
      if (response.id !== id) {
        return
      }
      clearTimeout(timeout)
      ipcMain.removeListener('ui:mobileMarkdownResponse', onResponse)
      if (response.ok) {
        resolve(response.result)
      } else {
        reject(new Error(response.error))
      }
    }
    ipcMain.on('ui:mobileMarkdownResponse', onResponse)
    mainWindow.webContents.send('ui:mobileMarkdownRequest', { id, ...request })
  })
}
