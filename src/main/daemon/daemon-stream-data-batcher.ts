import type { Socket } from 'node:net'
import { encodeNdjson, NDJSON_MAX_LINE_BYTES } from './ndjson'

type StreamDataClient = {
  streamSocket: Socket | null
}

type PendingStreamDataBatch = {
  timer: ReturnType<typeof setTimeout> | null
  queue: { sessionId: string; data: string }[]
  queuedChars: number
}

// Why: match main-process PTY IPC batching to avoid adding latency while
// removing daemon socket writes and JSON framing during bursty output.
const STREAM_DATA_BATCH_INTERVAL_MS = 8

type EnqueueOptions = {
  flushImmediately?: boolean
  flushMaxChars?: number
}

type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
}

function encodeStreamDataEvent(sessionId: string, data: string): string {
  return encodeNdjson({
    type: 'event',
    event: 'data',
    sessionId,
    payload: { data }
  })
}

function streamDataEventLineBytes(sessionId: string, data: string): number {
  return Buffer.byteLength(encodeStreamDataEvent(sessionId, data), 'utf8')
}

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}

function clampToSafeSplitIndex(value: string, start: number, end: number): number {
  if (end <= start || end >= value.length) {
    return end
  }
  const prev = value.charCodeAt(end - 1)
  const next = value.charCodeAt(end)
  return isHighSurrogate(prev) && isLowSurrogate(next) ? end - 1 : end
}

function nextSafeSplitIndex(value: string, start: number): number {
  const next = Math.min(value.length, start + 1)
  if (
    next < value.length &&
    isHighSurrogate(value.charCodeAt(start)) &&
    isLowSurrogate(value.charCodeAt(next))
  ) {
    return next + 1
  }
  return next
}

function splitStreamDataForNdjson(sessionId: string, data: string, maxLineBytes: number): string[] {
  if (streamDataEventLineBytes(sessionId, data) <= maxLineBytes) {
    return [data]
  }

  const chunks: string[] = []
  let start = 0
  while (start < data.length) {
    let low = start + 1
    let high = data.length
    let best = start

    while (low <= high) {
      const rawMid = Math.floor((low + high) / 2)
      const mid = clampToSafeSplitIndex(data, start, rawMid)
      if (mid <= start) {
        low = rawMid + 1
        continue
      }

      if (streamDataEventLineBytes(sessionId, data.slice(start, mid)) <= maxLineBytes) {
        best = mid
        low = rawMid + 1
      } else {
        high = rawMid - 1
      }
    }

    const end = best > start ? best : nextSafeSplitIndex(data, start)
    chunks.push(data.slice(start, end))
    start = end
  }

  return chunks
}

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private getClient: (clientId: string) => StreamDataClient | undefined
  private maxLineBytes: number

  constructor(
    getClient: (clientId: string) => StreamDataClient | undefined,
    options: DaemonStreamDataBatcherOptions = {}
  ) {
    this.getClient = getClient
    this.maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
  }

  enqueue(clientId: string, sessionId: string, data: string, options: EnqueueOptions = {}): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    let batch = this.pendingByClient.get(clientId)
    if (!batch) {
      batch = { timer: null, queue: [], queuedChars: 0 }
      this.pendingByClient.set(clientId, batch)
    }

    const last = batch.queue.at(-1)
    if (last?.sessionId === sessionId) {
      last.data += data
    } else {
      batch.queue.push({ sessionId, data })
    }
    batch.queuedChars += data.length

    if (
      options.flushImmediately === true &&
      this.queuedCharsForSession(batch, sessionId) <=
        (options.flushMaxChars ?? Number.POSITIVE_INFINITY)
    ) {
      this.flushSession(clientId, sessionId)
      return
    }
    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
  }

  flush(clientId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    if (batch.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }
    this.pendingByClient.delete(clientId)

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    for (const entry of batch.queue) {
      this.writeStreamDataEvent(client.streamSocket, entry.sessionId, entry.data)
    }
  }

  private queuedCharsForSession(batch: PendingStreamDataBatch, sessionId: string): number {
    let chars = 0
    for (const entry of batch.queue) {
      if (entry.sessionId === sessionId) {
        chars += entry.data.length
      }
    }
    return chars
  }

  private flushSession(clientId: string, sessionId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    const flushed: PendingStreamDataBatch['queue'] = []
    const retained: PendingStreamDataBatch['queue'] = []
    let flushedChars = 0
    for (const entry of batch.queue) {
      if (entry.sessionId === sessionId) {
        flushed.push(entry)
        flushedChars += entry.data.length
      } else {
        retained.push(entry)
      }
    }
    if (flushed.length === 0) {
      return
    }

    batch.queue = retained
    batch.queuedChars -= flushedChars
    if (batch.queue.length === 0) {
      if (batch.timer) {
        clearTimeout(batch.timer)
        batch.timer = null
      }
      this.pendingByClient.delete(clientId)
    }

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    for (const entry of flushed) {
      this.writeStreamDataEvent(client.streamSocket, entry.sessionId, entry.data)
    }
  }

  clear(clientId?: string): void {
    const batches =
      clientId === undefined
        ? Array.from(this.pendingByClient.entries())
        : [[clientId, this.pendingByClient.get(clientId)] as const]

    for (const [id, batch] of batches) {
      if (batch?.timer) {
        clearTimeout(batch.timer)
      }
      this.pendingByClient.delete(id)
    }
  }

  private writeStreamDataEvent(streamSocket: Socket, sessionId: string, data: string): void {
    // Why: createNdjsonParser rejects oversized lines. Terminal output can
    // burst faster than the batch interval, so writer-side chunking prevents
    // the daemon from dropping its own stream events at the receiver.
    for (const chunk of splitStreamDataForNdjson(sessionId, data, this.maxLineBytes)) {
      streamSocket.write(encodeStreamDataEvent(sessionId, chunk))
    }
  }
}
