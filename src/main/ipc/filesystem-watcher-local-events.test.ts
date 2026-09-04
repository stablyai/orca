import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangedPayload } from '../../shared/filesystem-entry-types'
import { WATCH_BATCH_TRAILING_MS } from '../../shared/filesystem-watch-batch-window'

const { statMock, subscribeMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  subscribeMock: vi.fn()
}))

vi.mock('fs/promises', () => ({ stat: statMock }))
vi.mock('./parcel-watcher-process', () => ({ subscribeViaWatcherProcess: subscribeMock }))

import { createLocalWatcher } from './filesystem-watcher-local-events'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve()
  }
}

type Sender = { isDestroyed: () => boolean; send: ReturnType<typeof vi.fn> }

describe('local filesystem watcher flush serialization', () => {
  let watcherCallback: ((error: Error | null, events: WatcherEvent[]) => void) | undefined
  let sender: Sender

  beforeEach(() => {
    vi.useFakeTimers()
    statMock.mockReset()
    subscribeMock.mockReset()
    watcherCallback = undefined
    sender = { isDestroyed: () => false, send: vi.fn() }
    subscribeMock.mockImplementation(async (_root: string, callback: typeof watcherCallback) => {
      watcherCallback = callback
      return { unsubscribe: vi.fn() }
    })
  })

  it('serializes an inflight flush and drains one follow-up without overlap', async () => {
    const firstStat = deferred<{ isDirectory: () => boolean }>()
    const secondStat = deferred<{ isDirectory: () => boolean }>()
    statMock.mockReturnValueOnce(firstStat.promise).mockReturnValueOnce(secondStat.promise)
    const root = await createLocalWatcher('/repo', '/repo')
    root.listeners.set(1, sender as never)
    const firstPath = '/repo/first.ts'
    const secondPath = '/repo/second.ts'

    watcherCallback?.(null, [{ type: 'update', path: firstPath }])
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS)
    await flushMicrotasks()
    expect(statMock).toHaveBeenCalledTimes(1)

    watcherCallback?.(null, [{ type: 'update', path: secondPath }])
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS)
    await flushMicrotasks()
    expect(statMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()

    firstStat.resolve({ isDirectory: () => true })
    await flushMicrotasks()
    expect(statMock).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledTimes(1)

    secondStat.resolve({ isDirectory: () => false })
    await flushMicrotasks()
    expect(sender.send).toHaveBeenCalledTimes(2)
    expect((sender.send.mock.calls[1][1] as FsChangedPayload).events).toEqual([
      { kind: 'update', absolutePath: secondPath, isDirectory: false }
    ])
  })

  it('coalesces a queued storm while preserving delete-before-create ordering', async () => {
    const firstStat = deferred<{ isDirectory: () => boolean }>()
    const createStat = deferred<{ isDirectory: () => boolean }>()
    statMock.mockReturnValueOnce(firstStat.promise).mockReturnValueOnce(createStat.promise)
    const root = await createLocalWatcher('/repo', '/repo')
    root.listeners.set(1, sender as never)
    const firstPath = '/repo/first.ts'
    const transientPath = '/repo/transient.ts'
    const replacedPath = '/repo/replaced.ts'

    watcherCallback?.(null, [{ type: 'update', path: firstPath }])
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS)
    await flushMicrotasks()
    watcherCallback?.(null, [
      { type: 'create', path: transientPath },
      { type: 'delete', path: transientPath },
      { type: 'delete', path: replacedPath },
      { type: 'create', path: replacedPath }
    ])
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS)
    await flushMicrotasks()
    expect(statMock).toHaveBeenCalledTimes(1)

    firstStat.resolve({ isDirectory: () => true })
    await flushMicrotasks()
    expect(statMock).toHaveBeenCalledTimes(2)
    createStat.resolve({ isDirectory: () => true })
    await flushMicrotasks()
    expect((sender.send.mock.calls[1][1] as FsChangedPayload).events).toEqual([
      { kind: 'delete', absolutePath: replacedPath },
      { kind: 'create', absolutePath: replacedPath, isDirectory: true }
    ])
  })

  it('drops queued events when the last listener is removed', async () => {
    const firstStat = deferred<{ isDirectory: () => boolean }>()
    const root = await createLocalWatcher('/repo', '/repo')
    root.listeners.set(1, sender as never)
    statMock.mockReturnValueOnce(firstStat.promise)

    watcherCallback?.(null, [{ type: 'update', path: '/repo/first.ts' }])
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS)
    await flushMicrotasks()
    watcherCallback?.(null, [{ type: 'update', path: '/repo/queued.ts' }])
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS)
    await flushMicrotasks()
    root.listeners.clear()

    firstStat.resolve({ isDirectory: () => true })
    await flushMicrotasks()
    expect(statMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('caps concurrent stats at eight for a full batch and keeps result order', async () => {
    const eventCount = 5_000
    const paths = Array.from({ length: eventCount }, (_, index) => `/repo/file-${index}.ts`)
    let inFlight = 0
    let peakInFlight = 0
    statMock.mockImplementation(async (statPath: string) => {
      inFlight++
      peakInFlight = Math.max(peakInFlight, inFlight)
      await Promise.resolve()
      inFlight--
      return { isDirectory: () => statPath.endsWith('-0.ts') }
    })
    const root = await createLocalWatcher('/repo', '/repo')
    root.listeners.set(1, sender as never)

    watcherCallback?.(
      null,
      paths.map((path) => ({ type: 'update' as const, path }))
    )
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS)
    // Why a loop, not a fixed microtask count: 5,000 stats through 8 lanes take many turns.
    for (let i = 0; i < eventCount * 4 && sender.send.mock.calls.length === 0; i++) {
      await Promise.resolve()
    }

    expect(statMock).toHaveBeenCalledTimes(eventCount)
    expect(peakInFlight).toBe(8)
    expect(sender.send).toHaveBeenCalledTimes(1)
    const { events } = sender.send.mock.calls[0][1] as FsChangedPayload
    expect(events).toEqual(
      paths.map((path) => ({
        kind: 'update',
        absolutePath: path,
        isDirectory: path.endsWith('-0.ts')
      }))
    )
  })

  it('leaves an open debounce window to the armed timer instead of draining early', async () => {
    const firstStat = deferred<{ isDirectory: () => boolean }>()
    const secondStat = deferred<{ isDirectory: () => boolean }>()
    statMock.mockReturnValueOnce(firstStat.promise).mockReturnValueOnce(secondStat.promise)
    const root = await createLocalWatcher('/repo', '/repo')
    root.listeners.set(1, sender as never)
    const transientPath = '/repo/transient.ts'
    const otherPath = '/repo/other.ts'

    watcherCallback?.(null, [{ type: 'update', path: '/repo/first.ts' }])
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS)
    await flushMicrotasks()

    // Queue an event mid-flush, then settle the flush before its debounce window closes.
    watcherCallback?.(null, [{ type: 'create', path: transientPath }])
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS - 50)
    firstStat.resolve({ isDirectory: () => true })
    await flushMicrotasks()
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(statMock).toHaveBeenCalledTimes(1)

    // The still-open window coalesces the create away instead of emitting a transient one.
    watcherCallback?.(null, [
      { type: 'delete', path: transientPath },
      { type: 'update', path: otherPath }
    ])
    vi.advanceTimersByTime(WATCH_BATCH_TRAILING_MS)
    await flushMicrotasks()
    secondStat.resolve({ isDirectory: () => false })
    await flushMicrotasks()

    expect(sender.send).toHaveBeenCalledTimes(2)
    expect((sender.send.mock.calls[1][1] as FsChangedPayload).events).toEqual([
      { kind: 'update', absolutePath: otherPath, isDirectory: false }
    ])
  })
})
