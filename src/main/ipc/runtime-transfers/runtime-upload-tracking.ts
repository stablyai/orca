import type { WebContents } from 'electron'
import type { RuntimeUploadProgressEvent } from '../../../shared/file-import/runtime-upload-staging-contract'

export const RUNTIME_UPLOAD_PROGRESS_CHANNEL = 'fs:runtimeUploadProgress'
export const RUNTIME_UPLOAD_CANCELED_MESSAGE = 'Upload canceled'

const PROGRESS_SEND_INTERVAL_MS = 100

type UploadSender = Pick<WebContents, 'id' | 'send' | 'isDestroyed'>

// Keyed by sender too, so one window can never cancel another window's upload.
const activeUploads = new Map<string, AbortController>()

function uploadKey(senderId: number, uploadId: string): string {
  return `${senderId}:${uploadId}`
}

/** Registers one file upload for cancel and throttled progress; call `end` when it settles. */
export function trackRuntimeUpload(
  sender: UploadSender,
  uploadId: string
): { signal: AbortSignal; reportProgress: (sentBytes: number) => void; end: () => void } {
  const key = uploadKey(sender.id, uploadId)
  const controller = new AbortController()
  activeUploads.set(key, controller)
  let sentAt = 0
  return {
    signal: controller.signal,
    reportProgress: (sentBytes) => {
      const now = Date.now()
      if (now - sentAt < PROGRESS_SEND_INTERVAL_MS || sender.isDestroyed()) {
        return
      }
      sentAt = now
      const event: RuntimeUploadProgressEvent = { uploadId, sentBytes }
      sender.send(RUNTIME_UPLOAD_PROGRESS_CHANNEL, event)
    },
    end: () => {
      // Finished uploads are forgotten: a late cancel has nothing to stop.
      if (activeUploads.get(key) === controller) {
        activeUploads.delete(key)
      }
    }
  }
}

export function cancelRuntimeUpload(senderId: number, uploadId: string): void {
  activeUploads
    .get(uploadKey(senderId, uploadId))
    ?.abort(new Error(RUNTIME_UPLOAD_CANCELED_MESSAGE))
}
