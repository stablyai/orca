import { ipcMain } from 'electron'
import type { LinkPreviewResult } from '../../shared/link-preview'
import { getLinkPreview } from '../link-preview/link-preview'

export function registerLinkPreviewHandlers(): void {
  ipcMain.removeHandler('linkPreview:get')
  ipcMain.handle(
    'linkPreview:get',
    async (_event, rawArgs?: unknown): Promise<LinkPreviewResult> => {
      const url =
        rawArgs &&
        typeof rawArgs === 'object' &&
        'url' in rawArgs &&
        typeof rawArgs.url === 'string'
          ? rawArgs.url
          : null
      return url ? getLinkPreview({ url }) : { kind: 'unavailable' }
    }
  )
}
