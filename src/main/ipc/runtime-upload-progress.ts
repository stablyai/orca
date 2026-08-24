export const RUNTIME_UPLOAD_PROGRESS_CHANNEL = 'fs:uploadProgress'

/** Bytes of one file that have reached the runtime, and how many there are in total. */
export type RuntimeUploadProgress = {
  uploadId: string
  sentBytes: number
  totalBytes: number
}

export type RuntimeUploadProgressSink = (progress: RuntimeUploadProgress) => void

const PROGRESS_MIN_INTERVAL_MS = 100
const PROGRESS_MIN_BYTES = 1024 * 1024

/**
 * Coalesce per-slice progress into something a renderer can keep up with.
 *
 * A 2 GB file is ~5,400 slices; forwarding each one would spend more time in IPC
 * than in the transfer. First and last are always emitted so a bar starts at a
 * known point and lands exactly on full.
 */
export function throttleRuntimeUploadProgress(
  sink: RuntimeUploadProgressSink,
  now: () => number = Date.now
): RuntimeUploadProgressSink {
  let lastSentBytes = -1
  let lastEmittedAt = -Infinity
  return (progress) => {
    const isTerminal = progress.sentBytes >= progress.totalBytes
    const isFirst = lastSentBytes < 0
    const currentTime = now()
    if (
      !isTerminal &&
      !isFirst &&
      progress.sentBytes - lastSentBytes < PROGRESS_MIN_BYTES &&
      currentTime - lastEmittedAt < PROGRESS_MIN_INTERVAL_MS
    ) {
      return
    }
    // Why: slices land in order, so a late duplicate would only ever move the bar
    // backwards.
    if (progress.sentBytes <= lastSentBytes) {
      return
    }
    lastSentBytes = progress.sentBytes
    lastEmittedAt = currentTime
    sink(progress)
  }
}
