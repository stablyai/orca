import { ipcMain, type WebContents } from 'electron'
import { abortWhenRendererGone } from './renderer-lifetime-abort'
import {
  cancelRuntimeUpload,
  forgetRuntimeUploadCancellation,
  forgetRuntimeUploadCancellationsForSender,
  scopeRuntimeUploadId
} from './runtime-upload-cancellation'

type CancelSender = Pick<WebContents, 'id' | 'once' | 'removeListener'>

const sendersWithCleanup = new WeakSet<CancelSender>()

function readUploadId(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || !('uploadId' in args)) {
    return undefined
  }
  return typeof args.uploadId === 'string' && args.uploadId.trim() !== ''
    ? args.uploadId
    : undefined
}

/** A reloaded or gone renderer can no longer release its remembered cancels. */
function forgetCancelsWhenRendererGoes(sender: CancelSender): void {
  if (sendersWithCleanup.has(sender)) {
    return
  }
  sendersWithCleanup.add(sender)
  const senderId = sender.id
  const lifetime = abortWhenRendererGone(sender)
  lifetime.signal.addEventListener(
    'abort',
    () => {
      lifetime.dispose()
      forgetRuntimeUploadCancellationsForSender(senderId)
      // A reload reuses WebContents, so its next cancel must arm cleanup again.
      sendersWithCleanup.delete(sender)
    },
    { once: true }
  )
}

export function registerRuntimeUploadCancelHandlers(): void {
  ipcMain.handle('fs:cancelRuntimeUpload', (event, args: unknown): void => {
    const uploadId = readUploadId(args)
    if (uploadId) {
      forgetCancelsWhenRendererGoes(event.sender)
      cancelRuntimeUpload(scopeRuntimeUploadId(event.sender.id, uploadId))
    }
  })

  ipcMain.handle('fs:releaseRuntimeUpload', (event, args: unknown): void => {
    const uploadId = readUploadId(args)
    if (uploadId) {
      forgetRuntimeUploadCancellation(scopeRuntimeUploadId(event.sender.id, uploadId))
    }
  })
}
