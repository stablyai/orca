import type { Socket } from 'node:net'
import { NDJSON_MAX_LINE_BYTES } from './ndjson'
import { BackpressuredStreamWriteQueue } from './daemon-stream-backpressure-queue'
import { encodeStreamDataEvent, splitStreamDataForNdjson } from './daemon-stream-ndjson-frames'

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
const DEFAULT_MAX_BACKPRESSURED_STREAM_BYTES = 8 * 1024 * 1024

type EnqueueOptions = {
  flushImmediately?: boolean
  flushMaxChars?: number
}

type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
  maxBackpressuredBytes?: number
}

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private backpressureQueue: BackpressuredStreamWriteQueue
  private getClient: (clientId: string) => StreamDataClient | undefined
  private maxLineBytes: number

  constructor(
    getClient: (clientId: string) => StreamDataClient | undefined,
    options: DaemonStreamDataBatcherOptions = {}
  ) {
    this.getClient = getClient
    this.maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
    this.backpressureQueue = new BackpressuredStreamWriteQueue(
      options.maxBackpressuredBytes ?? DEFAULT_MAX_BACKPRESSURED_STREAM_BYTES
    )
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
      this.writeStreamDataEvent(clientId, client.streamSocket, entry.sessionId, entry.data)
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
      this.writeStreamDataEvent(clientId, client.streamSocket, entry.sessionId, entry.data, {
        prioritizeBackpressuredSession: true
      })
    }
  }

  clear(clientId?: string): void {
    const clientIds =
      clientId === undefined
        ? new Set([...this.pendingByClient.keys(), ...this.backpressureQueue.clientIds()])
        : new Set([clientId])

    for (const id of clientIds) {
      const batch = this.pendingByClient.get(id)
      if (batch?.timer) {
        clearTimeout(batch.timer)
      }
      this.pendingByClient.delete(id)
      this.backpressureQueue.clear(id)
    }
  }

  writeEventLine(clientId: string, streamSocket: Socket, sessionId: string, line: string): void {
    // Why: session events (exit) must not overtake this session's queued output
    // on a backpressured socket; the priority path orders the event after the
    // session's own lines and ahead of unrelated non-priority backlog. Trimming
    // prefers non-priority lines, so the event is dropped only if the queue
    // overflows with priority-only frames.
    this.backpressureQueue.write(clientId, streamSocket, [{ sessionId, line, priority: true }], {
      prioritizeBackpressuredSession: true
    })
  }

  private writeStreamDataEvent(
    clientId: string,
    streamSocket: Socket,
    sessionId: string,
    data: string,
    opts: { prioritizeBackpressuredSession?: boolean } = {}
  ): void {
    // Why: createNdjsonParser rejects oversized lines. Terminal output can
    // burst faster than the batch interval, so writer-side chunking prevents
    // the daemon from dropping its own stream events at the receiver.
    const lines = splitStreamDataForNdjson(sessionId, data, this.maxLineBytes).map((chunk) => ({
      sessionId,
      line: encodeStreamDataEvent(sessionId, chunk),
      ...(opts.prioritizeBackpressuredSession ? { priority: true } : {})
    }))
    this.backpressureQueue.write(clientId, streamSocket, lines, opts)
  }
}
