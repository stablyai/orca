import type { FileHandle } from 'node:fs/promises'
import { settlesWithin } from './settles-within'
import { MAX_CONCURRENT_STREAMS, RelayErrorCode } from '../wsl-guest/protocol'
import { RelayStreamAckWindow } from './relay-stream-ack-window'

type StreamEntry = { handle: FileHandle; ack: RelayStreamAckWindow }

// Why: a stalled but connected client can hold a terminal-frame slot open indefinitely.
const OPERATION_SETTLE_DEADLINE_MS = 10_000

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
  // Why: terminal frames ride the non-dropping control lane, which destroys the link at 256 frames / 1 MB.
  // Holding a per-client slot until the frame settles caps queued terminal frames at
  // MAX_CONCURRENT_STREAMS per client (the control queue is per client); each slot is a
  // registry operation, so shutdown waits for undelivered terminal frames too.
  private pendingTerminalFramesByClient = new Map<number, number>()

  constructor(private readonly operationDeadlineMs = OPERATION_SETTLE_DEADLINE_MS) {}

  /** Tracks work that may still open or release a handle; disposeAll waits for it. */
  beginOperation(): () => void {
    if (this.disposed) {
      throw new Error('relay_file_stream_shutdown_fenced')
    }
    // Why: no Promise.withResolvers — the relay bundle still targets Node 18 hosts.
    let resolve!: () => void
    const pending = new Promise<void>((settle) => {
      resolve = settle
    })
    this.operations.add(pending)
    return () => {
      this.operations.delete(pending)
      resolve()
    }
  }

  /** Holds a per-client slot until a stream's terminal frame settles; see comment. */
  reserveTerminalFrameSlot(clientId: number): () => void {
    const pending = this.pendingTerminalFramesByClient.get(clientId) ?? 0
    if (pending >= MAX_CONCURRENT_STREAMS) {
      throw new TooManyStreamsError()
    }
    const finish = this.beginOperation()
    this.pendingTerminalFramesByClient.set(clientId, pending + 1)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      finish()
      const remaining = (this.pendingTerminalFramesByClient.get(clientId) ?? 1) - 1
      // Drop the entry at zero so a long-lived registry cannot accumulate one per detached client.
      if (remaining <= 0) {
        this.pendingTerminalFramesByClient.delete(clientId)
        return
      }
      this.pendingTerminalFramesByClient.set(clientId, remaining)
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

  /** Closes a handle opened outside a stream; a failed close stays retained for disposal retry. */
  releaseUnregisteredHandle(handle: FileHandle): Promise<void> {
    return this.release(this.retainHandle(handle))
  }

  private retainHandle(handle: FileHandle): number {
    const streamId = this.nextId++
    this.streams.set(streamId, { handle, ack: new RelayStreamAckWindow() })
    return streamId
  }

  abort(streamId: number): void {
    this.streams.get(streamId)?.ack.abort()
  }

  isAborted(streamId: number): boolean {
    return this.streams.get(streamId)?.ack.aborted ?? true
  }

  get(streamId: number): StreamEntry | undefined {
    return this.streams.get(streamId)
  }

  recordAck(streamId: number, seq: number): void {
    this.streams.get(streamId)?.ack.recordAck(seq)
  }

  ackedThroughSeq(streamId: number): number {
    return this.streams.get(streamId)?.ack.ackedThroughSeq ?? Number.MAX_SAFE_INTEGER
  }

  /** Resolves on the next ack/abort/release for this stream, or after the
   * stall-recheck interval so callers can re-evaluate staleness. */
  waitForAck(streamId: number): Promise<void> {
    return this.streams.get(streamId)?.ack.wait() ?? Promise.resolve()
  }

  /** Wake every parked pump (all streams) so it re-checks staleness — used
   * when a client detaches and its acks will never arrive. */
  wakeAllAckWaiters(): void {
    for (const entry of this.streams.values()) {
      entry.ack.wake()
    }
  }

  /** Concurrent callers share one close; only EBADF counts as already closed. */
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
        if (!isErrorWithCode(error, 'EBADF')) {
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

  /** Fences new streams until {@link reopen}; rejects while any handle is unclosed so a retry can finish. */
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
    const settled = await settlesWithin(Promise.all(this.operations), this.operationDeadlineMs)
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (!settled) {
      failures.push(new Error('relay_file_stream_operations_unsettled'))
    }
    if (failures.length > 0 || this.streams.size > 0) {
      throw new AggregateError(
        [...new Set([...failures, ...this.closeFailures.values()])],
        'relay_file_stream_shutdown_incomplete'
      )
    }
  }

  reopen(): void {
    this.disposed = false
  }
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}
