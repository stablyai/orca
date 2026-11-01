import { createWatcherSender } from './filesystem-watcher-test-sender'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import type { Event as WatcherEvent } from '@parcel/watcher'
import {
  WATCH_BATCH_INTERVAL_MS,
  WATCH_BATCH_LEADING_MS
} from '../../../../shared/filesystem-watch-batch-window'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('local filesystem watcher large batches', () => {
  const handlers: HandlerMap = {}

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
  })

  it('emits one overflow event for oversized native watcher batches', async () => {
    vi.useFakeTimers()
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let watcherCallback: ((err: Error | null, events: WatcherEvent[]) => void) | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe: vi.fn() } as never
    })
    const worktreePath = resolve('/tmp/repo')
    const sender = createWatcherSender(1)

    await handlers['fs:watchWorktree']({ sender }, { worktreePath })
    watcherCallback?.(
      null,
      Array.from({ length: 5_001 }, (_, index): WatcherEvent => ({
        type: 'update',
        path: join(worktreePath, `file-${index}.txt`)
      }))
    )

    await vi.advanceTimersByTimeAsync(150)

    expect(stat).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath,
      events: [{ kind: 'overflow', absolutePath: worktreePath }]
    })
    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('still coalesces a local burst on the shared leading window', async () => {
    vi.useFakeTimers()
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let watcherCallback: ((err: Error | null, events: WatcherEvent[]) => void) | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe: vi.fn() } as never
    })
    const worktreePath = resolve('/tmp/repo')
    const filePath = join(worktreePath, 'a.ts')
    const sender = createWatcherSender(1)

    await handlers['fs:watchWorktree']({ sender }, { worktreePath })
    watcherCallback?.(null, [{ type: 'update', path: filePath }])
    watcherCallback?.(null, [{ type: 'update', path: filePath }])

    await vi.advanceTimersByTimeAsync(WATCH_BATCH_LEADING_MS - 1)
    expect(sender.send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath,
      events: [{ kind: 'update', absolutePath: filePath, isDirectory: true }]
    })
    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('flushes a sustained local stream every interval instead of starving it', async () => {
    vi.useFakeTimers()
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let watcherCallback: ((err: Error | null, events: WatcherEvent[]) => void) | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe: vi.fn() } as never
    })
    const worktreePath = resolve('/tmp/repo')
    const sender = createWatcherSender(1)

    await handlers['fs:watchWorktree']({ sender }, { worktreePath })
    const step = 10
    for (let elapsed = 0; elapsed < 1_000; elapsed += step) {
      watcherCallback?.(null, [{ type: 'update', path: join(worktreePath, `f-${elapsed}.ts`) }])
      await vi.advanceTimersByTimeAsync(step)
    }

    const sends = sender.send.mock.calls.length
    expect(sends).toBeGreaterThanOrEqual(1_000 / WATCH_BATCH_INTERVAL_MS - 1)
    expect(sends).toBeLessThanOrEqual(1_000 / WATCH_BATCH_INTERVAL_MS + 1)
    await closeAllWatchers()
    vi.useRealTimers()
  })
})
