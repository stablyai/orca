import { ipcMain, type WebContents } from 'electron'
import {
  createRemoteDownloadProgressTracker,
  type RemoteDownloadTransferObserver
} from '../../../shared/remote-download-progress'
import { parseTransferId } from '../transfer-id'

export const REMOTE_DOWNLOAD_PROGRESS_CHANNEL = 'fs:downloadProgress'

export type RemoteDownloadSession = {
  observer: RemoteDownloadTransferObserver
  end: () => void
}

type RemoteDownloadSender = Pick<WebContents, 'id' | 'isDestroyed' | 'send'>

const activeDownloads = new Map<string, AbortController>()

// Why: download ids are renderer-chosen, so scope them to the window that started them.
function sessionKey(sender: Pick<WebContents, 'id'>, downloadId: string): string {
  return `${sender.id}:${downloadId}`
}

export const parseRemoteDownloadId = parseTransferId

/** Returns null when the caller did not ask for progress (older renderers, clipboard copies). */
export function beginRemoteDownloadSession(
  sender: RemoteDownloadSender,
  downloadId: string | undefined,
  totalBytes: number | null
): RemoteDownloadSession | null {
  if (!downloadId) {
    return null
  }
  const key = sessionKey(sender, downloadId)
  if (activeDownloads.has(key)) {
    throw new Error('Download is already running')
  }
  const controller = new AbortController()
  activeDownloads.set(key, controller)
  const tracker = createRemoteDownloadProgressTracker({
    downloadId,
    totalBytes,
    emit: (progress) => {
      if (!sender.isDestroyed()) {
        sender.send(REMOTE_DOWNLOAD_PROGRESS_CHANNEL, progress)
      }
    }
  })
  // Why: the first event tells the renderer the save dialog closed and bytes are about to move.
  tracker.flush()
  return {
    observer: {
      signal: controller.signal,
      onTotalBytes: tracker.setTotalBytes,
      onBytesTransferred: tracker.addBytes,
      onFileCompleted: tracker.completeFile
    },
    end: () => {
      tracker.flush()
      if (activeDownloads.get(key) === controller) {
        activeDownloads.delete(key)
      }
    }
  }
}

export function registerRemoteDownloadCancelHandler(): void {
  ipcMain.handle(
    'fs:cancelDownload',
    (event, args: { downloadId?: unknown }): { ok: true; canceled: boolean } => {
      const downloadId = parseRemoteDownloadId(args?.downloadId)
      const controller = downloadId
        ? activeDownloads.get(sessionKey(event.sender, downloadId))
        : undefined
      controller?.abort(new Error('Download canceled'))
      return { ok: true, canceled: controller !== undefined }
    }
  )
}
