import type { FileHandle } from 'fs/promises'
import { MAX_CONCURRENT_STREAMS, RelayErrorCode } from './protocol'

type StreamEntry = {
  handle: FileHandle
  aborted: boolean
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
    this.streams.set(streamId, { handle, aborted: false })
    return streamId
  }

  abort(streamId: number): void {
    const entry = this.streams.get(streamId)
    if (entry) {
      entry.aborted = true
    }
  }

  isAborted(streamId: number): boolean {
    return this.streams.get(streamId)?.aborted ?? true
  }

  get(streamId: number): StreamEntry | undefined {
    return this.streams.get(streamId)
  }

  async release(streamId: number): Promise<void> {
    const entry = this.streams.get(streamId)
    if (!entry) {
      return
    }
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
