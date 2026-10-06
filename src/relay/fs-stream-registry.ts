import type { FileHandle } from 'node:fs/promises'
import { MAX_CONCURRENT_STREAMS, RelayErrorCode, STREAM_ACK_STALL_RECHECK_MS } from './protocol'

type StreamEntry = {
  handle: FileHandle
  aborted: boolean
  /** Highest chunk seq the client acknowledged (in-order; -1 = none yet). */
  ackedThroughSeq: number
  /** Pumps parked on the ack credit window. Woken by acks, abort, release,
   * and a periodic stall recheck so a vanished client cannot strand a pump. */
  ackWaiters: Set<() => void>
}

export class TooManyStreamsError extends Error {
  readonly code = RelayErrorCode.TooManyStreams
  constructor() {
    super(`Too many concurrent streams (max ${MAX_CONCURRENT_STREAMS})`)
  }
}

export class RelayStreamRegistry {
  private streams = new Map<number, StreamEntry>()
  private nextId = 1

  register(handle: FileHandle): number {
    if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
      throw new TooManyStreamsError()
    }
    const streamId = this.nextId++
    this.streams.set(streamId, {
      handle,
      aborted: false,
      ackedThroughSeq: -1,
      ackWaiters: new Set()
    })
    return streamId
  }

  abort(streamId: number): void {
    const entry = this.streams.get(streamId)
    if (entry) {
      entry.aborted = true
      this.wakeAckWaiters(entry)
    }
  }

  isAborted(streamId: number): boolean {
    return this.streams.get(streamId)?.aborted ?? true
  }

  get(streamId: number): StreamEntry | undefined {
    return this.streams.get(streamId)
  }

  recordAck(streamId: number, seq: number): void {
    const entry = this.streams.get(streamId)
    if (!entry || typeof seq !== 'number' || !Number.isFinite(seq)) {
      return
    }
    if (seq > entry.ackedThroughSeq) {
      entry.ackedThroughSeq = seq
    }
    this.wakeAckWaiters(entry)
  }

  ackedThroughSeq(streamId: number): number {
    return this.streams.get(streamId)?.ackedThroughSeq ?? Number.MAX_SAFE_INTEGER
  }

  /** Resolves on the next ack/abort/release for this stream, or after the
   * stall-recheck interval so callers can re-evaluate staleness. */
  waitForAck(streamId: number): Promise<void> {
    const entry = this.streams.get(streamId)
    if (!entry || entry.aborted) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      let settled = false
      const timer = setTimeout(() => finish(), STREAM_ACK_STALL_RECHECK_MS)
      timer.unref?.()
      const finish = (): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        entry.ackWaiters.delete(finish)
        resolve()
      }
      entry.ackWaiters.add(finish)
    })
  }

  /** Wake every parked pump (all streams) so it re-checks staleness — used
   * when a client detaches and its acks will never arrive. */
  wakeAllAckWaiters(): void {
    for (const entry of this.streams.values()) {
      this.wakeAckWaiters(entry)
    }
  }

  private wakeAckWaiters(entry: StreamEntry): void {
    for (const waiter of Array.from(entry.ackWaiters)) {
      waiter()
    }
  }

  async release(streamId: number): Promise<void> {
    const entry = this.streams.get(streamId)
    if (!entry) {
      return
    }
    this.wakeAckWaiters(entry)
    this.streams.delete(streamId)
    try {
      await entry.handle.close()
    } catch {
      // release runs from multiple exit paths (pump, cancel, dispose); a
      // second close throws EBADF — swallow it.
    }
  }

  size(): number {
    return this.streams.size
  }

  async disposeAll(): Promise<void> {
    // Why: flag every stream as aborted so any in-flight pump exits its loop
    // cleanly on the next iteration boundary instead of seeing EBADF when
    // release closes the handle out from under an in-flight read.
    for (const id of this.streams.keys()) {
      this.abort(id)
    }
    const ids = Array.from(this.streams.keys())
    await Promise.all(ids.map((id) => this.release(id)))
  }
}
