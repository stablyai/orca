import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from './lazy-ipc-handle-group'
import type { LinkPreviewResult } from '../../shared/browser/link-preview'
import { getLinkPreview } from '../link-preview/link-preview'

export function registerLinkPreviewHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    ipcMain.removeHandler('linkPreview:get')
  }
  ipc.handle('linkPreview:get', async (_event, rawArgs?: unknown): Promise<LinkPreviewResult> => {
    const url =
      rawArgs && typeof rawArgs === 'object' && 'url' in rawArgs && typeof rawArgs.url === 'string'
        ? rawArgs.url
        : null
    return url ? getLinkPreview({ url }) : { kind: 'unavailable' }
  })
}
