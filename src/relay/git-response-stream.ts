// Streams large git RPC responses (diff family + exec) onto the bulk lane in
// chunks instead of one JSON-RPC frame, so a big diff cannot head-of-line-block
// interactive pty.data echo on the shared SSH channel. Mirrors the fs
// read-stream credit-window pattern (see fs-handler-file-read.ts) but the
// payload is an in-memory serialized string rather than a file handle.
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  GIT_RESPONSE_CHUNK_SIZE,
  MAX_GIT_RESPONSE_STREAM_BYTES,
  MAX_GIT_RESPONSE_STREAM_CHUNKS,
  MAX_CONCURRENT_STREAMS,
  RelayErrorCode,
  STREAM_ACK_WINDOW_CHUNKS,
  STREAM_ACK_STALL_RECHECK_MS,
  type GitResponseStreamMarker
} from './protocol'
import {
  encodeUtf8StringChunk,
  planUtf8StringChunks,
  type Utf8StringChunk
} from './git-response-utf8-chunks'

type GitResponseStreamEntry = {
  ownerClientId: number
  retainedBytes: number
  aborted: boolean
  /** Highest chunk seq admitted to the outbound bulk lane. */
  sentThroughSeq: number
  /** Highest chunk seq the client acknowledged (in-order; -1 = none yet). */
  ackedThroughSeq: number
  ackWaiters: Set<() => void>
}

type PreparedGitResponse =
  | { kind: 'buffer'; value: Buffer; byteLength: number; chunkCount: number }
  | {
      kind: 'string'
      value: string
      byteLength: number
      chunks: Utf8StringChunk[]
      chunkCount: number
    }

export const MAX_CONCURRENT_GIT_RESPONSE_STREAMS = MAX_CONCURRENT_STREAMS
export const MAX_ACTIVE_GIT_RESPONSE_STREAM_BYTES = 128 * 1024 * 1024

export class GitResponseStreamRegistry {
  private streams = new Map<number, GitResponseStreamEntry>()
  private nextId = 1
  private retainedBytes = 0

  constructor(private readonly maxRetainedBytes: number = MAX_ACTIVE_GIT_RESPONSE_STREAM_BYTES) {}

  private preparePayload(payload: Buffer | string): PreparedGitResponse {
    if (Buffer.isBuffer(payload)) {
      return {
        kind: 'buffer',
        value: payload,
        byteLength: payload.length,
        chunkCount: Math.ceil(payload.length / GIT_RESPONSE_CHUNK_SIZE)
      }
    }
    const chunks = planUtf8StringChunks(payload, GIT_RESPONSE_CHUNK_SIZE)
    return {
      kind: 'string',
      value: payload,
      byteLength: Buffer.byteLength(payload, 'utf8'),
      chunks,
      chunkCount: chunks.length
    }
  }

  private register(ownerClientId: number, retainedBytes: number): number {
    if (this.streams.size >= MAX_CONCURRENT_GIT_RESPONSE_STREAMS) {
      const error = new Error(
        `Too many concurrent git response streams (max ${MAX_CONCURRENT_GIT_RESPONSE_STREAMS})`
      ) as Error & { code: number }
      error.code = RelayErrorCode.TooManyStreams
      throw error
    }
    if (retainedBytes > this.maxRetainedBytes - this.retainedBytes) {
      const error = new Error(
        `Concurrent git responses exceed retained-byte limit (${this.maxRetainedBytes} bytes)`
      ) as Error & { code: number }
      error.code = RelayErrorCode.TooManyStreams
      throw error
    }
    const streamId = this.nextId++
    this.streams.set(streamId, {
      ownerClientId,
      retainedBytes,
      aborted: false,
      sentThroughSeq: -1,
      ackedThroughSeq: -1,
      ackWaiters: new Set()
    })
    this.retainedBytes += retainedBytes
    return streamId
  }

  recordAck(streamId: number, seq: number, clientId: number): void {
    const entry = this.streams.get(streamId)
    if (
      !entry ||
      entry.ownerClientId !== clientId ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      seq > entry.sentThroughSeq
    ) {
      return
    }
    if (seq > entry.ackedThroughSeq) {
      entry.ackedThroughSeq = seq
    }
    this.wake(entry)
  }

  abort(streamId: number, clientId: number): void {
    const entry = this.streams.get(streamId)
    if (entry?.ownerClientId === clientId) {
      entry.aborted = true
      this.wake(entry)
    }
  }

  /** Wake every parked pump so it re-checks staleness — used when a client
   * detaches and its acks will never arrive. */
  wakeAll(): void {
    for (const entry of this.streams.values()) {
      this.wake(entry)
    }
  }

  private wake(entry: GitResponseStreamEntry): void {
    for (const waiter of Array.from(entry.ackWaiters)) {
      waiter()
    }
  }

  private waitForAck(streamId: number): Promise<void> {
    const entry = this.streams.get(streamId)
    if (!entry || entry.aborted) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        entry.ackWaiters.delete(finish)
        resolve()
      }
      const timer = setTimeout(finish, STREAM_ACK_STALL_RECHECK_MS)
      timer.unref?.()
      entry.ackWaiters.add(finish)
    })
  }

  /**
   * Register a stream for `payload`, kick off the bulk-lane pump on a later
   * task (so the sentinel response reaches the client first), and return the
   * sentinel marker to send as the RPC result.
   */
  startStream(
    payload: Buffer | string,
    dispatcher: RelayDispatcher,
    context: RequestContext
  ): GitResponseStreamMarker {
    const prepared = this.preparePayload(payload)
    if (
      prepared.byteLength > MAX_GIT_RESPONSE_STREAM_BYTES ||
      prepared.chunkCount > MAX_GIT_RESPONSE_STREAM_CHUNKS
    ) {
      const error = new Error(
        `Git response exceeds stream limit (${prepared.byteLength} bytes, ${prepared.chunkCount} chunks)`
      ) as Error & { code: number }
      error.code = RelayErrorCode.StreamProtocolError
      throw error
    }
    const streamId = this.register(context.clientId, prepared.byteLength)
    // Why: kick the pump off the response task so the client sees the sentinel
    // (and can subscribe/reassemble) before the first chunk frame arrives.
    setImmediate(() => {
      void this.pump(streamId, prepared, dispatcher, context)
    })
    return {
      __orcaGitResponseStream: {
        streamId,
        totalBytes: prepared.byteLength,
        chunkCount: prepared.chunkCount
      }
    }
  }

  private async pump(
    streamId: number,
    payload: PreparedGitResponse,
    dispatcher: RelayDispatcher,
    context: RequestContext
  ): Promise<void> {
    const entry = this.streams.get(streamId)
    if (!entry) {
      return
    }
    const clientId = context.clientId
    let seq = 0
    let endReason: 'end' | 'aborted' | 'stale' = 'end'
    try {
      for (seq = 0; seq < payload.chunkCount; seq += 1) {
        if (context.isStale()) {
          endReason = 'stale'
          break
        }
        if (entry.aborted) {
          endReason = 'aborted'
          break
        }
        // Why: credit window — the client acks each chunk, bounding how many
        // bulk bytes a keystroke echo can queue behind on the shared channel.
        while (
          seq - entry.ackedThroughSeq > STREAM_ACK_WINDOW_CHUNKS &&
          !context.isStale() &&
          !entry.aborted
        ) {
          await this.waitForAck(streamId)
        }
        if (context.isStale()) {
          endReason = 'stale'
          break
        }
        if (entry.aborted) {
          endReason = 'aborted'
          break
        }
        const chunk =
          payload.kind === 'buffer'
            ? payload.value.subarray(
                seq * GIT_RESPONSE_CHUNK_SIZE,
                (seq + 1) * GIT_RESPONSE_CHUNK_SIZE
              )
            : encodeUtf8StringChunk(payload.value, payload.chunks[seq])
        // Why: encode only the current chunk; eager base64 retained a second,
        // 4/3-expanded copy of every parked response until its final ACK.
        const data = chunk.toString('base64')
        entry.sentThroughSeq = seq
        await dispatcher.notifyBulk(
          'git.responseChunk',
          { streamId, seq, data },
          {
            clientId
          }
        )
      }
      if (endReason === 'end') {
        await dispatcher.notifyBulk('git.responseEnd', { streamId }, { clientId })
      }
    } catch (err) {
      if (!context.isStale() && !entry.aborted) {
        try {
          await dispatcher.notifyBulk(
            'git.responseError',
            {
              streamId,
              message: err instanceof Error ? err.message : String(err)
            },
            { clientId }
          )
        } catch {
          // Why: the original failure may be the owning channel closing; a
          // second send failure must not escape this detached pump.
        }
      }
    } finally {
      this.deleteStream(streamId)
    }
  }

  private deleteStream(streamId: number): void {
    const entry = this.streams.get(streamId)
    if (!entry) {
      return
    }
    this.streams.delete(streamId)
    this.retainedBytes -= entry.retainedBytes
  }

  disposeAll(): void {
    for (const entry of this.streams.values()) {
      entry.aborted = true
      this.wake(entry)
    }
    this.streams.clear()
    this.retainedBytes = 0
  }
}
