import type { Socket } from 'net'
import { encodeNdjson } from './ndjson'

type StreamDataClient = {
  streamSocket: Socket | null
}

type PendingStreamEvent =
  | { kind: 'data'; sessionId: string; data: string }
  | { kind: 'exit'; sessionId: string; code: number }

type PendingStreamDataBatch = {
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
const STREAM_DATA_BATCH_INTERVAL_MS = 8
const STREAM_DATA_BACKPRESSURE_WARN_BYTES = 512 * 1024
const STREAM_DATA_DRAIN_TIMEOUT_MS = 30_000
const STREAM_DATA_MAX_QUEUED_BYTES = 8 * 1024 * 1024
const STREAM_DATA_MAX_PAYLOAD_CHARS = 64 * 1024
const STREAM_DATA_MAX_EVENTS_PER_FLUSH = 1024

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private getClient: (clientId: string) => StreamDataClient | undefined
  private onStreamFailure: (clientId: string) => void

  constructor(
    getClient: (clientId: string) => StreamDataClient | undefined,
    opts: { onStreamFailure?: (clientId: string) => void } = {}
  ) {
    this.getClient = getClient
    this.onStreamFailure = opts.onStreamFailure ?? (() => {})
  }

  enqueue(clientId: string, sessionId: string, data: string): void {
    for (let offset = 0; offset < data.length; offset += STREAM_DATA_MAX_PAYLOAD_CHARS) {
      const shouldContinue = this.enqueueEvent(clientId, {
        kind: 'data',
        sessionId,
        data: data.slice(offset, offset + STREAM_DATA_MAX_PAYLOAD_CHARS)
      })
      if (!shouldContinue) {
        return
      }
    }
  }

  enqueueExit(clientId: string, sessionId: string, code: number): void {
    this.enqueueEvent(clientId, { kind: 'exit', sessionId, code })
    this.flush(clientId)
  }

  private enqueueEvent(clientId: string, event: PendingStreamEvent): boolean {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return false
    }

    let batch = this.pendingByClient.get(clientId)
    if (!batch) {
      batch = {
        timer: null,
        drainTimer: null,
        cleanupWait: null,
        queue: [],
        queueHead: 0,
        queuedDataBytes: 0,
        waitingForDrain: false,
        warnedBackpressure: false
      }
      this.pendingByClient.set(clientId, batch)
    }

    const last = batch.queue.at(-1)
    if (
      event.kind === 'data' &&
      last?.kind === 'data' &&
      last.sessionId === event.sessionId &&
      last.data.length + event.data.length <= STREAM_DATA_MAX_PAYLOAD_CHARS
    ) {
      last.data += event.data
      batch.queuedDataBytes += Buffer.byteLength(event.data, 'utf8')
    } else {
      batch.queue.push(event)
      if (event.kind === 'data') {
        batch.queuedDataBytes += Buffer.byteLength(event.data, 'utf8')
      }
    }

    if (batch.queuedDataBytes > STREAM_DATA_MAX_QUEUED_BYTES) {
      console.warn('[daemon] PTY stream socket queue exceeded limit', {
        clientId,
        queuedEvents: batch.queue.length - batch.queueHead,
        queuedBytes: batch.queuedDataBytes
      })
      // Why: backpressure is on the renderer's single stream socket. Once that
      // socket is unhealthy, per-PTY recovery cannot make progress until the
      // client reconnects and reattaches its active sessions.
      this.failStream(clientId)
      return false
    }

    if (!batch.timer && !batch.waitingForDrain) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
    return true
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
    if (batch.waitingForDrain) {
      return
    }

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      this.pendingByClient.delete(clientId)
      return
    }
    const streamSocket = client.streamSocket

    let flushedEvents = 0
    while (batch.queueHead < batch.queue.length) {
      const entry = batch.queue[batch.queueHead]!
      batch.queueHead += 1
      flushedEvents += 1
      if (entry.kind === 'data') {
        batch.queuedDataBytes -= Buffer.byteLength(entry.data, 'utf8')
      }
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
      const ok = streamSocket.write(encodeNdjson(payload))
      if (!ok) {
        batch.waitingForDrain = true
        this.compactQueue(batch)
        if (
          batch.queuedDataBytes >= STREAM_DATA_BACKPRESSURE_WARN_BYTES &&
          !batch.warnedBackpressure
        ) {
          batch.warnedBackpressure = true
          console.warn('[daemon] PTY stream socket backpressure', {
            clientId,
            queuedEvents: batch.queue.length - batch.queueHead,
            queuedBytes: batch.queuedDataBytes
          })
        }
        let settled = false
        const handleDrain = (): void => {
          if (settled) {
            return
          }
          cleanupWait()
          const current = this.pendingByClient.get(clientId)
          if (current !== batch) {
            return
          }
          current.waitingForDrain = false
          this.flush(clientId)
        }
        const handleTerminal = (): void => {
          if (settled) {
            return
          }
          cleanupWait()
          if (this.pendingByClient.get(clientId) === batch) {
            this.pendingByClient.delete(clientId)
          }
        }
        const cleanupWait = (): void => {
          settled = true
          if (batch.drainTimer) {
            clearTimeout(batch.drainTimer)
            batch.drainTimer = null
          }
          batch.cleanupWait = null
          streamSocket.removeListener('drain', handleDrain)
          streamSocket.removeListener('close', handleTerminal)
          streamSocket.removeListener('error', handleTerminal)
        }
        batch.cleanupWait = cleanupWait
        batch.drainTimer = setTimeout(() => {
          if (settled) {
            return
          }
          console.warn('[daemon] PTY stream socket drain timed out', {
            clientId,
            queuedEvents: batch.queue.length - batch.queueHead,
            queuedBytes: batch.queuedDataBytes
          })
          cleanupWait()
          this.failStream(clientId)
        }, STREAM_DATA_DRAIN_TIMEOUT_MS)
        batch.drainTimer.unref?.()
        streamSocket.once('close', handleTerminal)
        streamSocket.once('error', handleTerminal)
        streamSocket.once('drain', handleDrain)
        return
      }
      if (
        flushedEvents >= STREAM_DATA_MAX_EVENTS_PER_FLUSH &&
        batch.queueHead < batch.queue.length
      ) {
        this.compactQueue(batch)
        batch.timer = setTimeout(() => this.flush(clientId), 0)
        batch.timer.unref?.()
        return
      }
    }
    this.pendingByClient.delete(clientId)
  }

  clear(clientId?: string): void {
    const batches =
      clientId === undefined
        ? Array.from(this.pendingByClient.entries())
        : [[clientId, this.pendingByClient.get(clientId)] as const]

    for (const [id, batch] of batches) {
      batch?.cleanupWait?.()
      if (batch?.timer) {
        clearTimeout(batch.timer)
      }
      if (batch?.drainTimer) {
        clearTimeout(batch.drainTimer)
      }
      this.pendingByClient.delete(id)
    }
  }

  private compactQueue(batch: PendingStreamDataBatch): void {
    if (batch.queueHead === 0) {
      return
    }
    batch.queue = batch.queue.slice(batch.queueHead)
    batch.queueHead = 0
  }

  private failStream(clientId: string): void {
    this.clear(clientId)
    this.onStreamFailure(clientId)
  }
}
