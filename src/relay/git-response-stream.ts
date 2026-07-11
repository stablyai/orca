// Streams large git RPC responses (diff family + exec) onto the bulk lane in
// chunks instead of one JSON-RPC frame, so a big diff cannot head-of-line-block
// interactive pty.data echo on the shared SSH channel. Mirrors the fs
// read-stream credit-window pattern (see fs-handler-file-read.ts) but the
// payload is an in-memory serialized string rather than a file handle.
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  GIT_RESPONSE_CHUNK_SIZE,
  STREAM_ACK_WINDOW_CHUNKS,
  STREAM_ACK_STALL_RECHECK_MS,
  type GitResponseStreamMarker
} from './protocol'

type GitResponseStreamEntry = {
  ownerClientId: number
  aborted: boolean
  /** Highest chunk seq the client acknowledged (in-order; -1 = none yet). */
  ackedThroughSeq: number
  ackWaiters: Set<() => void>
}

/** Serialized git responses are chunked as base64 so multi-byte UTF-8
 * sequences never split across a chunk boundary (the client concatenates the
 * decoded bytes and parses once). */
function encodeChunks(payload: Buffer): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < payload.length; offset += GIT_RESPONSE_CHUNK_SIZE) {
    chunks.push(payload.subarray(offset, offset + GIT_RESPONSE_CHUNK_SIZE).toString('base64'))
  }
  return chunks
}

export class GitResponseStreamRegistry {
  private streams = new Map<number, GitResponseStreamEntry>()
  private nextId = 1

  private register(ownerClientId: number): number {
    const streamId = this.nextId++
    this.streams.set(streamId, {
      ownerClientId,
      aborted: false,
      ackedThroughSeq: -1,
      ackWaiters: new Set()
    })
    return streamId
  }

  recordAck(streamId: number, seq: number, clientId: number): void {
    const entry = this.streams.get(streamId)
    if (
      !entry ||
      entry.ownerClientId !== clientId ||
      typeof seq !== 'number' ||
      !Number.isFinite(seq)
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
    payload: Buffer,
    dispatcher: RelayDispatcher,
    context: RequestContext
  ): GitResponseStreamMarker {
    const streamId = this.register(context.clientId)
    const chunks = encodeChunks(payload)
    // Why: kick the pump off the response task so the client sees the sentinel
    // (and can subscribe/reassemble) before the first chunk frame arrives.
    setImmediate(() => {
      void this.pump(streamId, chunks, dispatcher, context)
    })
    return {
      __orcaGitResponseStream: { streamId, totalBytes: payload.length, chunkCount: chunks.length }
    }
  }

  private async pump(
    streamId: number,
    chunks: string[],
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
      for (seq = 0; seq < chunks.length; seq += 1) {
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
        // Why: notifyBulk waits out sink saturation so chunk frames never pile
        // up in the outbound pipe ahead of interactive pty.data frames.
        await dispatcher.notifyBulk(
          'git.responseChunk',
          { streamId, seq, data: chunks[seq] },
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
      this.streams.delete(streamId)
    }
  }

  disposeAll(): void {
    for (const entry of this.streams.values()) {
      entry.aborted = true
      this.wake(entry)
    }
    this.streams.clear()
  }
}
