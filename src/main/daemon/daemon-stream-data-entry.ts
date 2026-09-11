import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'

export type DaemonStreamEnqueueOptions = {
  flushImmediately?: boolean
  flushMaxChars?: number
  rawLength?: number
  transformed?: boolean
  seq?: number
  incarnationId?: string
}

export function appendDaemonStreamData(
  batch: PendingStreamDataBatch,
  sessionId: string,
  data: string,
  options: DaemonStreamEnqueueOptions
): number {
  const last = batch.queue.at(-1)
  // Control/transformed spans and zero-weight query copies keep separate source accounting.
  if (
    last?.sessionId === sessionId &&
    last.incarnationId === options.incarnationId &&
    !last.control &&
    !last.transformed &&
    options.transformed !== true &&
    ((last.sequenceChars ?? last.data.length) === 0) === ((options.rawLength ?? data.length) === 0)
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
      ...(options.incarnationId === undefined ? {} : { incarnationId: options.incarnationId }),
      ...(options.rawLength === undefined || options.rawLength === data.length
        ? {}
        : { sequenceChars: options.rawLength }),
      ...(options.transformed ? { transformed: true } : {}),
      ...(options.seq === undefined ? {} : { seq: options.seq })
    })
  }
  batch.queuedChars += data.length
  const queuedAfter = (batch.queuedCharsBySession.get(sessionId) ?? 0) + data.length
  batch.queuedCharsBySession.set(sessionId, queuedAfter)
  return queuedAfter
}
