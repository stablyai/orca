import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import { clampToSafeBulkWriteSplitIndex } from './daemon-stream-data-split'
import { streamEventJsonBytes, type TransientEntryLease } from './daemon-transient-accounting'
import type { DaemonStreamFraming } from './daemon-stream-binary-framing'
import type { DaemonEvent } from './types'
import { accountDaemonStreamEntry } from './daemon-stream-entry-accounting'

export type DaemonStreamEnqueueOptions = {
  flushImmediately?: boolean
  flushMaxChars?: number
  rawLength?: number
  transformed?: boolean
  seq?: number
}

export function appendDaemonStreamData(
  batch: PendingStreamDataBatch,
  sessionId: string,
  data: string,
  options: DaemonStreamEnqueueOptions
): number {
  let last = batch.queue.at(-1)
  // Why: control and transformed spans mark indivisible source-stream positions.
  if (
    last?.sessionId === sessionId &&
    !last.control &&
    !last.observation &&
    !last.queryOnly &&
    !last.transformed &&
    options.transformed !== true
  ) {
    last.data += data
    const rawLengthBefore = last.sequenceChars ?? last.data.length - data.length
    const combinedRawLength = rawLengthBefore + (options.rawLength ?? data.length)
    last.sequenceChars = combinedRawLength === last.data.length ? undefined : combinedRawLength
    last.seq = options.seq
  } else {
    const lease = batch.admission?.partition(sessionId, 1024)
    // Admission can remove separators and merge the display tail on actual capacity loss.
    last = batch.queue.at(-1)
    if (
      last?.sessionId === sessionId &&
      !last.control &&
      !last.observation &&
      !last.queryOnly &&
      !last.transformed &&
      !options.transformed
    ) {
      lease?.release()
      return appendDaemonStreamData(batch, sessionId, data, options)
    }
    batch.queue.push(
      accountDaemonStreamEntry(batch, {
        sessionId,
        data,
        ...(lease ? { lease } : {}),
        ...(options.rawLength === undefined || options.rawLength === data.length
          ? {}
          : { sequenceChars: options.rawLength }),
        ...(options.transformed ? { transformed: true } : {}),
        ...(options.seq === undefined ? {} : { seq: options.seq })
      })
    )
  }
  batch.queuedChars += data.length
  const queuedAfter = (batch.queuedCharsBySession.get(sessionId) ?? 0) + data.length
  batch.queuedCharsBySession.set(sessionId, queuedAfter)
  return queuedAfter
}

/** Reserve the added partition and encoding peak before slicing or constructing its event. */
export function prepareLeasedStreamWrite(
  entry: PendingStreamDataBatch['queue'][number],
  framing: DaemonStreamFraming,
  maxLineBytes: number
): { buffer: Buffer; lease: TransientEntryLease; end: number } | null | undefined {
  const source = entry.lease!
  // Transformed display is already one indivisible baseline frame; only its added callback is leased.
  if (entry.transformed) {
    return undefined
  }
  const metadataBytes = 256 + streamEventJsonBytes(entry.sessionId)
  const chars = Math.max(1, Math.min(2048, Math.floor((maxLineBytes - metadataBytes) / 6)))
  const end =
    entry.control || entry.transformed
      ? entry.data.length
      : clampToSafeBulkWriteSplitIndex(entry.data, Math.min(entry.data.length, chars))
  const upper = entry.control ? 5 + streamEventJsonBytes(entry.control) : metadataBytes + 6 * end
  if (upper > 16 * 1024) {
    return null
  }
  const lease = source.partition(1024 + 3 * upper + 2 * end, 1, entry.queryOnly)
  if (!lease) {
    return null
  }
  const rawLength =
    entry.sequenceChars === 0
      ? 0
      : entry.transformed
        ? (entry.sequenceChars ?? entry.data.length)
        : end
  const event: DaemonEvent = entry.control ?? {
    type: 'event',
    event: 'data',
    sessionId: entry.sessionId,
    payload: {
      data: entry.data.slice(0, end),
      rawLength,
      sequenceChars: rawLength,
      ...(entry.seq === undefined ? {} : { seq: entry.seq - (entry.data.length - end) }),
      ...(entry.transformed ? { transformed: true } : {})
    }
  }
  const buffer = source.owner.encodeQueued(lease, event, framing)
  if (!buffer) {
    lease.release()
    return null
  }
  if (entry.queryOnly) {
    source.queryChars -= end
    lease.queryChars = end
  }
  return { buffer, lease, end }
}
