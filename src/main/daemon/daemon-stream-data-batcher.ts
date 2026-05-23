import type { Socket } from 'net'
import { encodeNdjson } from './ndjson'

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

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private getClient: (clientId: string) => StreamDataClient | undefined

  constructor(getClient: (clientId: string) => StreamDataClient | undefined) {
    this.getClient = getClient
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
      client.streamSocket.write(
        encodeNdjson({
          type: 'event',
          event: 'data',
          sessionId: entry.sessionId,
          payload: { data: entry.data }
        })
      )
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
      client.streamSocket.write(
        encodeNdjson({
          type: 'event',
          event: 'data',
          sessionId: entry.sessionId,
          payload: { data: entry.data }
        })
      )
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
}
