import { ipcMain } from 'electron'
import type { IpcHandleRegistrar } from '../lazy-ipc-handle-group'
import {
  cancelBrowserServerDownloadCopy,
  copyBrowserServerDownloadHere
} from '../../browser/downloads/browser-server-download-copy'
import type { BrowserServerDownloadCopyResult } from '../../../shared/browser/downloads/browser-server-download-copy'
import { abortWhenRendererGone } from '../renderer-requests/renderer-lifetime-abort'
import { isTrustedBrowserRenderer } from './browser-renderer-trust'

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is required`)
  }
  return value
}

/** Save to this computer, on a streamed page's download toast: only Orca's own window starts one. */
export function registerBrowserServerDownloadCopyHandlers(ipc: IpcHandleRegistrar = ipcMain): void {
  if (ipc === ipcMain) {
    ipcMain.removeHandler('browser:copyServerDownload')
    ipcMain.removeHandler('browser:cancelServerDownloadCopy')
  }
  ipc.handle(
    'browser:copyServerDownload',
    async (
      event,
      args: {
        environmentId?: unknown
        copyId?: unknown
        filename?: unknown
        expectedEnvironmentPairingRevision?: unknown
      }
    ): Promise<BrowserServerDownloadCopyResult> => {
      if (!isTrustedBrowserRenderer(event.sender)) {
        throw new Error('Not allowed.')
      }
      const revision = args?.expectedEnvironmentPairingRevision
      const lifetime = abortWhenRendererGone(event.sender)
      try {
        return await copyBrowserServerDownloadHere(
          {
            environmentId: requiredString(args?.environmentId, 'environmentId'),
            copyId: requiredString(args?.copyId, 'copyId'),
            filename: requiredString(args?.filename, 'filename'),
            ...(typeof revision === 'number'
              ? { expectedEnvironmentPairingRevision: revision }
              : {})
          },
          lifetime.signal
        )
      } finally {
        lifetime.dispose()
      }
    }
  )
  ipc.handle('browser:cancelServerDownloadCopy', (event, args: { copyId?: unknown }) => {
    if (!isTrustedBrowserRenderer(event.sender) || typeof args?.copyId !== 'string') {
      return false
    }
    return cancelBrowserServerDownloadCopy(args.copyId)
  })
}
