import { encodeNdjson } from './ndjson'
import type { PendingStreamDataBatch, StreamQueueEntry } from './daemon-stream-keep-tail-drop'

// Budget callbacks, stream requests and queue objects even when their data payload is empty.
export const STREAM_ENTRY_OVERHEAD_BYTES = 256

export function accountDaemonStreamEntry(
  batch: PendingStreamDataBatch,
  entry: StreamQueueEntry
): StreamQueueEntry {
  entry.queued = true
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
  entry.queued = false
  if (batch.latestSnapshots?.get(entry.sessionId) === entry) {
    batch.latestSnapshots.delete(entry.sessionId)
  }
  const remaining =
    (batch.queuedMetadataBytesBySession.get(entry.sessionId) ?? 0) - (entry.retainedBytes ?? 0)
  if (remaining > 0) {
    batch.queuedMetadataBytesBySession.set(entry.sessionId, remaining)
  } else {
    batch.queuedMetadataBytesBySession.delete(entry.sessionId)
  }
  entry.retainedBytes = undefined
}

/** Slot invalidation is constant work; compact only after dead slots pay for the traversal. */
export function discardDaemonStreamEntry(
  batch: PendingStreamDataBatch,
  entry: StreamQueueEntry | undefined
): void {
  if (!entry?.queued) {
    return
  }
  releaseDaemonStreamEntry(batch, entry)
  entry.discarded = true
  batch.discardedEntries = (batch.discardedEntries ?? 0) + 1
  if (batch.discardedEntries * 2 >= batch.queue.length) {
    batch.queue = batch.queue.filter((candidate) => !candidate.discarded)
    batch.discardedEntries = 0
  }
}
