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

import {
  closeAllWatchers,
  closeLocalWatcherForWorktreePath,
  registerFilesystemWatcherHandlers
} from './filesystem-watcher'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { WATCH_BATCH_TRAILING_MS } from '../../shared/filesystem-watch-batch-window'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>
type WatcherCallback = (err: Error | null, events: WatcherEvent[]) => void

/** Holds every event-path stat open so teardown can be driven mid-fan-out. */
function trackDeferredStats(): {
  live: () => number
  settle: (rounds?: number) => Promise<void>
} {
  const pending: (() => void)[] = []
  let live = 0
  vi.mocked(stat).mockImplementation((target: unknown) => {
    if (!String(target).endsWith('.ts')) {
      // The watch install stats the root itself; only event paths are deferred.
      return Promise.resolve({ isDirectory: () => true } as never)
    }
    live += 1
    return new Promise((resolveStat) => {
      pending.push(() => {
        live -= 1
        resolveStat({ isDirectory: () => false } as never)
      })
    }) as never
  })
  return {
    live: () => live,
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

function statPathsMatching(marker: string): string[] {
  return vi
    .mocked(stat)
    .mock.calls.map((call) => String(call[0]))
    .filter((statPath) => statPath.includes(marker))
}

describe('local filesystem watcher flush teardown', () => {
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

  /** Leaves one flush awaiting stats and one flush queued behind it, neither settled. */
  async function primeActiveAndQueuedFlush(
    worktreePath: string
  ): Promise<{ sender: { send: ReturnType<typeof vi.fn> } }> {
    let watcherCallback: WatcherCallback | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as WatcherCallback
      return { unsubscribe: vi.fn() } as never
    })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    await handlers['fs:watchWorktree']({ sender }, { worktreePath })

    watcherCallback?.(null, burst(worktreePath, 'a', 16))
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)
    watcherCallback?.(null, burst(worktreePath, 'b', 16))
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS)
    return { sender }
  }

  it('does not emit or start a queued flush once closeAllWatchers has run', async () => {
    const worktreePath = resolve('/tmp/repo-close-all-mid-flush')
    const { sender } = await primeActiveAndQueuedFlush(worktreePath)

    let closed = false
    const closePromise = closeAllWatchers().then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(stats.live()).toBeGreaterThan(0)
    expect(closed).toBe(false)

    await stats.settle()
    await closePromise

    expect(sender.send).not.toHaveBeenCalled()
    expect(statPathsMatching('b-')).toEqual([])
  })

  it('does not emit or start a queued flush once the worktree watcher is closed for deletion', async () => {
    const worktreePath = resolve('/tmp/repo-close-local-mid-flush')
    const { sender } = await primeActiveAndQueuedFlush(worktreePath)

    let closed = false
    const closePromise = closeLocalWatcherForWorktreePath(worktreePath).then(() => {
      closed = true
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(stats.live()).toBeGreaterThan(0)
    expect(closed).toBe(false)

    await stats.settle()
    await closePromise

    expect(sender.send).not.toHaveBeenCalled()
    expect(statPathsMatching('b-')).toEqual([])
  })
})
