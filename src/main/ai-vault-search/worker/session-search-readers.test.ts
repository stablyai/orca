import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type * as WorkerClient from './session-search-worker-client'
import { SessionSearchReaders } from './session-search-readers'
import type { SearchWorkerRequest } from './session-search-worker-protocol'

let createWorker: () => BlockedReader
vi.mock('./session-search-worker-client', async (importOriginal) => {
  const actual = await importOriginal<typeof WorkerClient>()
  return {
    ...actual,
    SessionSearchWorkerClient: class extends actual.SessionSearchWorkerClient {
      constructor() {
        super(undefined, () => createWorker())
      }
    }
  }
})

class BlockedReader extends EventEmitter {
  private release!: (code: number) => void
  private readonly exit = new Promise<number>((resolve) => {
    this.release = resolve
  })
  unref(): void {}
  postMessage(request: SearchWorkerRequest): void {
    if (request.command.op === 'open') {
      queueMicrotask(() => this.emit('message', { id: request.id }))
    }
  }
  terminate(): Promise<number> {
    return this.exit
  }
  exitNativeCall(): void {
    this.release(0)
  }
}

afterEach(() => vi.useRealTimers())
it('fails timed-out searches before native retirement and keeps clear waiting for both blocked readers', async () => {
  vi.useFakeTimers()
  const native: BlockedReader[] = []
  createWorker = () => {
    const worker = new BlockedReader()
    native.push(worker)
    return worker
  }
  const readers = new SessionSearchReaders('blocked-index.sqlite', null)
  for (let i = 0; i < 2; i++) {
    const result = expect(readers.query({ query: 'common' })).rejects.toThrow(
      'Could not search sessions'
    )
    await vi.advanceTimersByTimeAsync(10_000)
    await result
  }
  await expect(readers.query({ query: 'common' })).rejects.toThrow('Could not search sessions')
  let cleared = false
  const retired = readers.close().then(() => {
    cleared = true
  })
  await Promise.resolve()
  expect(cleared).toBe(false)
  for (const worker of native) {
    worker.exitNativeCall()
  }
  await retired
  expect(cleared).toBe(true)
})
