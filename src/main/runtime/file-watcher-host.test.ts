import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../shared/types'

type MockWorker = {
  terminated: boolean
  postedMessages: unknown[]
  workerData: unknown
  on(event: string, listener: (arg?: unknown) => void): MockWorker
  once(event: string, listener: (arg?: unknown) => void): MockWorker
  off(event: string, listener: (arg?: unknown) => void): MockWorker
  postMessage(message: unknown): void
  terminate(): Promise<number>
  emit(event: string, arg?: unknown): void
  listenerCount(event: string): number
}

const workerState = vi.hoisted(() => {
  const instances: MockWorker[] = []
  class MockWorkerImpl {
    terminated = false
    postedMessages: unknown[] = []
    workerData: unknown
    private listeners = new Map<string, { listener: (arg?: unknown) => void; once: boolean }[]>()

    constructor(_workerPath: string, options: { workerData?: unknown }) {
      this.workerData = options.workerData
      instances.push(this as unknown as MockWorker)
    }

    on(event: string, listener: (arg?: unknown) => void): this {
      const list = this.listeners.get(event) ?? []
      list.push({ listener, once: false })
      this.listeners.set(event, list)
      return this
    }

    once(event: string, listener: (arg?: unknown) => void): this {
      const list = this.listeners.get(event) ?? []
      list.push({ listener, once: true })
      this.listeners.set(event, list)
      return this
    }

    off(event: string, listener: (arg?: unknown) => void): this {
      const list = this.listeners.get(event) ?? []
      this.listeners.set(
        event,
        list.filter((entry) => entry.listener !== listener)
      )
      return this
    }

    postMessage(message: unknown): void {
      this.postedMessages.push(message)
    }

    async terminate(): Promise<number> {
      this.terminated = true
      return 0
    }

    emit(event: string, arg?: unknown): void {
      const entries = this.listeners.get(event)?.slice() ?? []
      for (const entry of entries) {
        if (entry.once) {
          this.off(event, entry.listener)
        }
        entry.listener(arg)
      }
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.length ?? 0
    }
  }
  return { instances, MockWorkerImpl }
})

vi.mock('electron', () => ({
  app: { isPackaged: false }
}))

vi.mock('worker_threads', () => ({
  Worker: workerState.MockWorkerImpl
}))

import { watchFileExplorerInWorker } from './file-watcher-host'

function lastWorker(): MockWorker {
  const worker = workerState.instances.at(-1)
  if (!worker) {
    throw new Error('no worker spawned')
  }
  return worker
}

describe('watchFileExplorerInWorker', () => {
  beforeEach(() => {
    workerState.instances.length = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves to an unsubscribe fn once the worker reports ready', async () => {
    const promise = watchFileExplorerInWorker('/repo', vi.fn())
    const worker = lastWorker()
    expect(worker.workerData).toMatchObject({ rootPath: '/repo' })

    worker.emit('message', { type: 'ready' })
    const dispose = await promise
    expect(typeof dispose).toBe('function')
  })

  it('forwards worker events to the callback only after ready', async () => {
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const promise = watchFileExplorerInWorker('/repo', onEvents)
    const worker = lastWorker()
    worker.emit('message', { type: 'ready' })
    await promise

    const events: FsChangeEvent[] = [
      { kind: 'update', absolutePath: '/repo/a.txt', isDirectory: false }
    ]
    worker.emit('message', { type: 'events', events })
    expect(onEvents).toHaveBeenCalledWith(events)
  })

  it('rejects if the worker errors before the crawl goes live', async () => {
    const promise = watchFileExplorerInWorker('/repo', vi.fn())
    const worker = lastWorker()
    worker.emit('message', { type: 'error', message: 'addon missing' })

    await expect(promise).rejects.toThrow('addon missing')
    expect(worker.terminated).toBe(true)
  })

  it('rejects if the worker exits before ready', async () => {
    const promise = watchFileExplorerInWorker('/repo', vi.fn())
    const worker = lastWorker()
    worker.emit('exit', 1)

    await expect(promise).rejects.toThrow(/exited before ready/)
  })

  it('emits an overflow if a live worker crashes', async () => {
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const promise = watchFileExplorerInWorker('/repo', onEvents)
    const worker = lastWorker()
    worker.emit('message', { type: 'ready' })
    await promise

    worker.emit('error', new Error('boom'))
    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: '/repo' }])
  })

  it('unsubscribes and waits for a clean worker exit without force-terminating', async () => {
    const promise = watchFileExplorerInWorker('/repo', vi.fn())
    const worker = lastWorker()
    worker.emit('message', { type: 'ready' })
    const dispose = await promise

    const disposed = dispose()
    expect(worker.postedMessages).toContainEqual({ type: 'unsubscribe' })
    // The worker unsubscribes its native watcher, closes its port and exits on
    // its own — no force terminate, which is what corrupts the native watcher.
    worker.emit('exit', 0)
    await disposed
    expect(worker.terminated).toBe(false)
    expect(worker.listenerCount('exit')).toBe(1)

    // Idempotent: a second dispose does nothing further.
    await dispose()
    expect(
      worker.postedMessages.filter((m) => (m as { type?: string }).type === 'unsubscribe')
    ).toHaveLength(1)
  })

  it('shares pending dispose work across racing callers', async () => {
    const promise = watchFileExplorerInWorker('/repo', vi.fn())
    const worker = lastWorker()
    worker.emit('message', { type: 'ready' })
    const dispose = await promise

    const firstDispose = dispose()
    const secondDispose = dispose()
    expect(secondDispose).toBe(firstDispose)
    expect(
      worker.postedMessages.filter((m) => (m as { type?: string }).type === 'unsubscribe')
    ).toHaveLength(1)

    worker.emit('exit', 0)
    await Promise.all([firstDispose, secondDispose])
    expect(worker.terminated).toBe(false)
  })

  it('force-terminates the worker only if it fails to exit within the timeout', async () => {
    vi.useFakeTimers()
    try {
      const promise = watchFileExplorerInWorker('/repo', vi.fn())
      const worker = lastWorker()
      worker.emit('message', { type: 'ready' })
      const dispose = await promise

      const disposed = dispose()
      expect(worker.postedMessages).toContainEqual({ type: 'unsubscribe' })
      expect(worker.listenerCount('exit')).toBe(2)
      // Worker is wedged and never emits exit: the backstop must terminate it.
      await vi.advanceTimersByTimeAsync(10_000)
      await disposed
      expect(worker.terminated).toBe(true)
      expect(worker.listenerCount('exit')).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops forwarding events after dispose', async () => {
    const onEvents = vi.fn<(events: FsChangeEvent[]) => void>()
    const promise = watchFileExplorerInWorker('/repo', onEvents)
    const worker = lastWorker()
    worker.emit('message', { type: 'ready' })
    const dispose = await promise
    const disposed = dispose()
    worker.emit('exit', 0)
    await disposed
    onEvents.mockClear()

    worker.emit('message', {
      type: 'events',
      events: [{ kind: 'update', absolutePath: '/repo/a.txt' }]
    })
    expect(onEvents).not.toHaveBeenCalled()
  })
})
