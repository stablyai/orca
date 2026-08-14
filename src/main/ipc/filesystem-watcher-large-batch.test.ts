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

  it('accepts a large local watcher event batch without overflowing V8 arguments', async () => {
    vi.useFakeTimers()
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const worktreePath = resolve('/tmp/repo')
    let watcherCallback: ((err: Error | null, events: WatcherEvent[]) => void) | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe: vi.fn() } as never
    })

    await handlers['fs:watchWorktree'](
      { sender: { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 } },
      { worktreePath }
    )

    const events = Array.from(
      { length: 200_000 },
      (_, index): WatcherEvent => ({ type: 'delete', path: join(worktreePath, `file-${index}`) })
    )

    expect(() => watcherCallback?.(null, events)).not.toThrow()
    await closeAllWatchers()
    vi.useRealTimers()
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
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath })
    watcherCallback?.(
      null,
      Array.from(
        { length: 5_001 },
        (_, index): WatcherEvent => ({
          type: 'update',
          path: join(worktreePath, `file-${index}.txt`)
        })
      )
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

  it('still coalesces a local burst on the shared trailing window', async () => {
    vi.useFakeTimers()
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let watcherCallback: ((err: Error | null, events: WatcherEvent[]) => void) | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe: vi.fn() } as never
    })
    const worktreePath = resolve('/tmp/repo')
    const filePath = join(worktreePath, 'a.ts')
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath })
    watcherCallback?.(null, [{ type: 'update', path: filePath }])
    watcherCallback?.(null, [{ type: 'update', path: filePath }])

    await vi.advanceTimersByTimeAsync(WATCH_BATCH_TRAILING_MS - 1)
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

  it('still flushes a sustained local stream at the shared max wait', async () => {
    vi.useFakeTimers()
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let watcherCallback: ((err: Error | null, events: WatcherEvent[]) => void) | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe: vi.fn() } as never
    })
    const worktreePath = resolve('/tmp/repo')
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath })
    // Step under the trailing window so only the max wait can force a flush.
    const step = 100
    for (let elapsed = 0; elapsed <= WATCH_BATCH_MAX_WAIT_MS; elapsed += step) {
      watcherCallback?.(null, [{ type: 'update', path: join(worktreePath, `f-${elapsed}.ts`) }])
      if (elapsed < WATCH_BATCH_MAX_WAIT_MS) {
        expect(sender.send).not.toHaveBeenCalled()
      }
      await vi.advanceTimersByTimeAsync(step)
    }

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect((sender.send.mock.calls[0][1] as FsChangedPayload).events).toHaveLength(6)
    await closeAllWatchers()
    vi.useRealTimers()
  })
})
