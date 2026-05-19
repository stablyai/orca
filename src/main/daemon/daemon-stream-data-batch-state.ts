import type { Socket } from 'net'
import { encodeNdjson } from './ndjson'

export type StreamDataClient = {
  streamSocket: Socket | null
}

export type PendingStreamEvent =
  | { kind: 'data'; sessionId: string; data: string }
  | { kind: 'exit'; sessionId: string; code: number }

export type PendingStreamDataBatch = {
  timer: ReturnType<typeof setTimeout> | null
  drainTimer: ReturnType<typeof setTimeout> | null
  cleanupWait: (() => void) | null
  queue: PendingStreamEvent[]
  queueHead: number
  queuedDataBytes: number
  waitingForDrain: boolean
  warnedBackpressure: boolean
}

// Why: match main-process PTY IPC batching to avoid adding latency while
// removing daemon socket writes and JSON framing during bursty output.
export const STREAM_DATA_BATCH_INTERVAL_MS = 8
export const STREAM_DATA_BACKPRESSURE_WARN_BYTES = 512 * 1024
export const STREAM_DATA_DRAIN_TIMEOUT_MS = 30_000
export const STREAM_DATA_MAX_QUEUED_BYTES = 8 * 1024 * 1024
export const STREAM_DATA_MAX_PAYLOAD_CHARS = 64 * 1024
export const STREAM_DATA_MAX_EVENTS_PER_FLUSH = 1024
export const INTERACTIVE_OUTPUT_WINDOW_MS = 100
export const INTERACTIVE_OUTPUT_MAX_CHARS = 1024

export function createPendingStreamDataBatch(): PendingStreamDataBatch {
  return {
    timer: null,
    drainTimer: null,
    cleanupWait: null,
    queue: [],
    queueHead: 0,
    queuedDataBytes: 0,
    waitingForDrain: false,
    warnedBackpressure: false
  }
}

export function compactStreamDataBatch(batch: PendingStreamDataBatch): void {
  if (batch.queueHead === 0) {
    return
  }
  batch.queue = batch.queue.slice(batch.queueHead)
  batch.queueHead = 0
}

export function streamInputKey(clientId: string, sessionId: string): string {
  return `${clientId}\0${sessionId}`
}

export function getQueuedDataForSession(batch: PendingStreamDataBatch, sessionId: string): string {
  let data = ''
  for (let index = batch.queueHead; index < batch.queue.length; index++) {
    const entry = batch.queue[index]!
    if (entry.kind === 'data' && entry.sessionId === sessionId) {
      data += entry.data
    }
  }
  return data
}

export function removeQueuedDataForSession(batch: PendingStreamDataBatch, sessionId: string): void {
  const remaining: PendingStreamEvent[] = []
  for (let index = batch.queueHead; index < batch.queue.length; index++) {
    const entry = batch.queue[index]!
    if (entry.kind === 'data' && entry.sessionId === sessionId) {
      batch.queuedDataBytes -= Buffer.byteLength(entry.data, 'utf8')
    } else {
      remaining.push(entry)
    }
  }
  batch.queue = remaining
  batch.queueHead = 0
}

export function writeStreamEvent(streamSocket: Socket, entry: PendingStreamEvent): boolean {
  const payload =
    entry.kind === 'data'
      ? {
          type: 'event',
          event: 'data',
          sessionId: entry.sessionId,
          payload: { data: entry.data }
        }
      : {
          type: 'event',
          event: 'exit',
          sessionId: entry.sessionId,
          payload: { code: entry.code }
        }
  return streamSocket.write(encodeNdjson(payload))
}
