import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'

export type DaemonStreamEnqueueOptions = {
  flushImmediately?: boolean
  flushMaxChars?: number
  rawLength?: number
  transformed?: boolean
  seq?: number
  incarnationId?: PtyIncarnationId
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
    options.transformed !== true &&
    last.incarnationId === options.incarnationId
  ) {
    last.data += data
    const rawLengthBefore = last.sequenceChars ?? last.data.length - data.length
    const combinedRawLength = rawLengthBefore + (options.rawLength ?? data.length)
    last.sequenceChars = combinedRawLength === last.data.length ? undefined : combinedRawLength
    last.seq = options.seq
  } else {
    batch.queue.push({
      sessionId,
      data,
      ...(options.rawLength === undefined || options.rawLength === data.length
        ? {}
        : { sequenceChars: options.rawLength }),
      ...(options.transformed ? { transformed: true } : {}),
      ...(options.seq === undefined ? {} : { seq: options.seq }),
      ...(options.incarnationId === undefined ? {} : { incarnationId: options.incarnationId })
    })
  }
  batch.queuedChars += data.length
  const queuedAfter = (batch.queuedCharsBySession.get(sessionId) ?? 0) + data.length
  batch.queuedCharsBySession.set(sessionId, queuedAfter)
  return queuedAfter
}
