import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('fs/promises', () => ({
  stat: vi.fn()
}))

vi.mock('@parcel/watcher', () => ({
  subscribe: vi.fn()
}))

vi.mock('./filesystem-watcher-wsl', () => ({
  createWslWatcher: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  onSshFilesystemProviderRegistered: () => () => {}
}))

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangedPayload } from '../../shared/types'
import {
  WATCH_BATCH_MAX_WAIT_MS,
  WATCH_BATCH_TRAILING_MS
} from '../../shared/filesystem-watch-batch-window'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>
type WatcherCallback = (err: Error | null, events: WatcherEvent[]) => void

// Mirrors DIRECTORY_STAT_CONCURRENCY in parcel-watcher-event-delivery.ts.
const EXPECTED_STAT_CONCURRENCY = 8

/** Holds every event-path stat open so a flush can be observed mid-fan-out. */
function trackDeferredStats(): {
  live: () => number
  peak: () => number
  settle: (rounds?: number) => Promise<void>
} {
  const pending: (() => void)[] = []
  let live = 0
  let peak = 0
  vi.mocked(stat).mockImplementation((target: unknown) => {
    if (!String(target).endsWith('.ts')) {
      // The watch install stats the root itself; only event paths are deferred.
      return Promise.resolve({ isDirectory: () => true } as never)
    }
    live += 1
    peak = Math.max(peak, live)
    return new Promise((resolveStat) => {
      pending.push(() => {
        live -= 1
        resolveStat({ isDirectory: () => false } as never)
      })
    }) as never
  })
  return {
    live: () => live,
    peak: () => peak,
    settle: async (rounds = 200): Promise<void> => {
      for (let i = 0; i < rounds; i++) {
        while (pending.length > 0) {
          pending.shift()?.()
        }
        await (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : Promise.resolve())
      }
    }
  }
}

function burst(worktreePath: string, prefix: string, count: number): WatcherEvent[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'create' as const,
    path: join(worktreePath, `${prefix}-${index}.ts`)
  }))
}

describe('local filesystem watcher flush fan-out', () => {
  const handlers: HandlerMap = {}
  let stats: ReturnType<typeof trackDeferredStats>

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(subscribeParcelWatcher).mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
    vi.useFakeTimers()
    stats = trackDeferredStats()
  })

  afterEach(async () => {
    // Why: the directory-stat budget is process-wide, so a test that ends with stats still open
    // (a failing assertion, say) would starve every later test in this file.
    await Promise.all([closeAllWatchers(), stats.settle()])
    vi.useRealTimers()
  })

  async function watchRoot(
    worktreePath: string
  ): Promise<{ sender: { send: ReturnType<typeof vi.fn> }; emit: WatcherCallback }> {
    let watcherCallback: WatcherCallback | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as WatcherCallback
      return { unsubscribe: vi.fn() } as never
    })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    await handlers['fs:watchWorktree']({ sender }, { worktreePath })
    return { sender, emit: (err, events) => watcherCallback?.(err, events) }
  }

  it('bounds concurrent stats in one flush to the watcher child limit', async () => {
    const worktreePath = resolve('/tmp/repo-flush-bound')
    const { sender, emit } = await watchRoot(worktreePath)

    const events = burst(worktreePath, 'a', 64)
    emit(null, events)
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)

    expect(stats.peak()).toBeLessThanOrEqual(EXPECTED_STAT_CONCURRENCY)

    await stats.settle()
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect((sender.send.mock.calls[0][1] as FsChangedPayload).events).toHaveLength(events.length)
  })

  it('caps concurrent stats across every watched root, not per root', async () => {
    const roots: (Awaited<ReturnType<typeof watchRoot>> & { worktreePath: string })[] = []
    for (let index = 0; index < 4; index++) {
      const worktreePath = resolve(`/tmp/repo-flush-multi-${index}`)
      roots.push({ worktreePath, ...(await watchRoot(worktreePath)) })
    }

    for (const root of roots) {
      root.emit(null, burst(root.worktreePath, 'a', 24))
    }
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)

    expect(stats.live()).toBeLessThanOrEqual(EXPECTED_STAT_CONCURRENCY)
    expect(stats.peak()).toBeLessThanOrEqual(EXPECTED_STAT_CONCURRENCY)

    await stats.settle()
    for (const root of roots) {
      expect(root.sender.send).toHaveBeenCalledTimes(1)
      expect((root.sender.send.mock.calls[0][1] as FsChangedPayload).events).toHaveLength(24)
    }
  })

  it('leaves events that arrive after a flush is queued to their own trailing window', async () => {
    const worktreePath = resolve('/tmp/repo-flush-orphan-timer')
    const { sender, emit } = await watchRoot(worktreePath)

    emit(null, burst(worktreePath, 'a', 4))
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)

    // Second burst's timer fires while the first flush is still awaiting stats, creating the queued flush.
    const secondBurst = burst(worktreePath, 'b', 4)
    emit(null, secondBurst)
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)

    // Third burst installs a newer trailing timer that the queued flush must not drain early.
    const thirdBurst = burst(worktreePath, 'c', 4)
    emit(null, thirdBurst)
    await stats.settle()

    expect(sender.send).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)
    await stats.settle()
    expect(sender.send).toHaveBeenCalledTimes(2)
    expect(
      (sender.send.mock.calls[1][1] as FsChangedPayload).events.map((event) => event.absolutePath)
    ).toEqual([...secondBurst, ...thirdBurst].map((event) => event.path))

    // A timer orphaned by the queued flush would fire mid-window and deliver this burst early.
    emit(null, burst(worktreePath, 'd', 4))
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS - 1)
    await stats.settle()
    expect(sender.send).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1)
    await stats.settle()
    expect(sender.send).toHaveBeenCalledTimes(3)
  })

  it('queues a flush that lands while another flush for the same root is awaiting stats', async () => {
    const worktreePath = resolve('/tmp/repo-flush-overlap')
    const { sender, emit } = await watchRoot(worktreePath)

    emit(null, burst(worktreePath, 'a', 64))
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)

    // Second burst arrives while the first flush is still awaiting its stats.
    const secondBurst = burst(worktreePath, 'b', 64)
    emit(null, secondBurst)
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_MAX_WAIT_MS)

    const statPaths = vi.mocked(stat).mock.calls.map((call) => String(call[0]))
    expect(statPaths.some((statPath) => statPath.includes('b-'))).toBe(false)
    expect(stats.live()).toBeLessThanOrEqual(EXPECTED_STAT_CONCURRENCY)
    expect(stats.peak()).toBeLessThanOrEqual(EXPECTED_STAT_CONCURRENCY)

    await stats.settle()
    expect(sender.send).toHaveBeenCalledTimes(2)
    expect(
      (sender.send.mock.calls[1][1] as FsChangedPayload).events.map((event) => event.absolutePath)
    ).toEqual(secondBurst.map((event) => event.path))
  })

  it('keeps delivering after a flush throws instead of stranding the queued flush', async () => {
    const worktreePath = resolve('/tmp/repo-flush-throws')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { sender, emit } = await watchRoot(worktreePath)
    sender.send.mockImplementationOnce(() => {
      throw new Error('renderer went away mid-flush')
    })

    emit(null, burst(worktreePath, 'a', 64))
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)

    const secondBurst = burst(worktreePath, 'b', 64)
    emit(null, secondBurst)
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_MAX_WAIT_MS)
    await stats.settle()

    expect(sender.send).toHaveBeenCalledTimes(2)
    expect(
      (sender.send.mock.calls[1][1] as FsChangedPayload).events.map((event) => event.absolutePath)
    ).toEqual(secondBurst.map((event) => event.path))
    consoleError.mockRestore()
  })
})
