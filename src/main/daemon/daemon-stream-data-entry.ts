import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import { writeStreamDataEvents } from './daemon-stream-data-split'
import { encodeNdjson } from './ndjson'
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
  const last = batch.queue.at(-1)
  // Why: control and transformed spans mark indivisible source-stream positions.
  if (
    last?.sessionId === sessionId &&
    !last.control &&
    !last.transformed &&
    options.transformed !== true
  ) {
    last.data += data
    const rawLengthBefore = last.sequenceChars ?? last.data.length - data.length
    const combinedRawLength = rawLengthBefore + (options.rawLength ?? data.length)
    last.sequenceChars = combinedRawLength === last.data.length ? undefined : combinedRawLength
    last.seq = options.seq
  } else {
    batch.queue.push(
      accountDaemonStreamEntry(batch, {
        sessionId,
        data,
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

function takeDaemonStreamSession(
  batch: PendingStreamDataBatch,
  sessionId: string
): PendingStreamDataBatch['queue'] {
  const flushed: PendingStreamDataBatch['queue'] = []
  const retained: PendingStreamDataBatch['queue'] = []
  for (const entry of batch.queue) {
    if (entry.sessionId === sessionId) {
      flushed.push(entry)
      batch.queuedChars -= entry.data.length
    } else {
      retained.push(entry)
    }
  }
  batch.queue = retained
  batch.queuedCharsBySession.delete(sessionId)
  batch.queuedMetadataBytesBySession.delete(sessionId)
  batch.droppableQueuedSessionIds.delete(sessionId)
  if (batch.queue.length === 0 && batch.timer) {
    clearTimeout(batch.timer)
    batch.timer = null
  }
  return flushed
}

export function flushDaemonStreamSession(
  batch: PendingStreamDataBatch,
  sessionId: string,
  maxLineBytes: number,
  write: (line: string) => void
): void {
  for (const entry of takeDaemonStreamSession(batch, sessionId)) {
    if (entry.control) {
      write(encodeNdjson(entry.control))
    } else {
      writeStreamDataEvents(
        { write },
        entry.sessionId,
        entry.data,
        maxLineBytes,
        entry.sequenceChars ?? entry.data.length,
        entry.seq,
        entry.transformed
      )
    }
  }
}
