import { encodeNdjson } from './ndjson'
import type { PendingStreamDataBatch, StreamQueueEntry } from './daemon-stream-keep-tail-drop'

// Budget callbacks, stream requests and queue objects even when their data payload is empty.
export const STREAM_ENTRY_OVERHEAD_BYTES = 256

export function accountDaemonStreamEntry(
  batch: PendingStreamDataBatch,
  entry: StreamQueueEntry
): StreamQueueEntry {
  entry.retainedBytes =
    STREAM_ENTRY_OVERHEAD_BYTES +
    (entry.control ? Buffer.byteLength(encodeNdjson(entry.control)) : 0)
  batch.queuedMetadataBytesBySession.set(
    entry.sessionId,
    (batch.queuedMetadataBytesBySession.get(entry.sessionId) ?? 0) + entry.retainedBytes
  )
  return entry
}

export function releaseDaemonStreamEntry(
  batch: PendingStreamDataBatch,
  entry: StreamQueueEntry
): void {
  const remaining =
    (batch.queuedMetadataBytesBySession.get(entry.sessionId) ?? 0) - (entry.retainedBytes ?? 0)
  if (remaining > 0) {
    batch.queuedMetadataBytesBySession.set(entry.sessionId, remaining)
  } else {
    batch.queuedMetadataBytesBySession.delete(entry.sessionId)
  }
}
