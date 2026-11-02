import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
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
  // Control and transformed spans mark indivisible source-stream positions.
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
