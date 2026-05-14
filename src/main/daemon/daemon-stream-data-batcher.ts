import type { Socket } from 'net'
import { encodeNdjson } from './ndjson'

type StreamDataClient = {
  streamSocket: Socket | null
}

type PendingStreamDataBatch = {
  timer: ReturnType<typeof setTimeout> | null
  queue: { sessionId: string; data: string }[]
}

// Why: match main-process PTY IPC batching to avoid adding latency while
// removing daemon socket writes and JSON framing during bursty output.
const STREAM_DATA_BATCH_INTERVAL_MS = 8

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private getClient: (clientId: string) => StreamDataClient | undefined

  constructor(getClient: (clientId: string) => StreamDataClient | undefined) {
    this.getClient = getClient
  }

  enqueue(clientId: string, sessionId: string, data: string): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    let batch = this.pendingByClient.get(clientId)
    if (!batch) {
      batch = { timer: null, queue: [] }
      this.pendingByClient.set(clientId, batch)
    }

    const last = batch.queue.at(-1)
    if (last?.sessionId === sessionId) {
      last.data += data
    } else {
      batch.queue.push({ sessionId, data })
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
