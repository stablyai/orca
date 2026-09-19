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
  private disposed = false
  private closing = new Map<number, Promise<void>>()
  private closeFailures = new Map<number, unknown>()
  private operations = new Set<Promise<void>>()

  beginOperation(): () => void {
    if (this.disposed) {
      throw new Error('relay_file_stream_shutdown_fenced')
    }
    const pending = Promise.withResolvers<void>()
    this.operations.add(pending.promise)
    return () => {
      this.operations.delete(pending.promise)
      pending.resolve()
    }
  }

  register(handle: FileHandle): number {
    if (this.disposed) {
      throw new Error('relay_file_stream_shutdown_fenced')
    }
    if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
      throw new TooManyStreamsError()
    }
    return this.retainHandle(handle)
  }

  releaseUnregisteredHandle(handle: FileHandle): Promise<void> {
    return this.release(this.retainHandle(handle))
  }

  private retainHandle(handle: FileHandle): number {
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

  release(streamId: number): Promise<void> {
    const pending = this.closing.get(streamId)
    if (pending) {
      return pending
    }
    const entry = this.streams.get(streamId)
    if (!entry) {
      return Promise.resolve()
    }
    this.abort(streamId)
    const close = Promise.resolve()
      .then(() => entry.handle.close())
      .catch((error: unknown) => {
        if ((error as { code?: string } | null)?.code !== 'EBADF') {
          this.closeFailures.set(streamId, error)
          throw error
        }
      })
      .then(() => {
        this.streams.delete(streamId)
        this.closeFailures.delete(streamId)
      })
      .finally(() => {
        this.closing.delete(streamId)
      })
    this.closing.set(streamId, close)
    return close
  }

  size(): number {
    return this.streams.size
  }

  async disposeAll(): Promise<void> {
    this.disposed = true
    // Why: flag every stream as aborted so any in-flight pump exits its loop
    // cleanly on the next iteration boundary instead of seeing EBADF when
    // release closes the handle out from under an in-flight read.
    for (const id of this.streams.keys()) {
      this.abort(id)
    }
    const ids = Array.from(this.streams.keys())
    const results = await Promise.allSettled(ids.map((id) => this.release(id)))
    await Promise.all(this.operations)
    const failures = results.filter((result) => result.status === 'rejected')
    if (failures.length > 0 || this.streams.size > 0) {
      throw new AggregateError(
        [
          ...new Set([...failures.map((failure) => failure.reason), ...this.closeFailures.values()])
        ],
        'relay_file_stream_shutdown_incomplete'
      )
    }
  }
}
