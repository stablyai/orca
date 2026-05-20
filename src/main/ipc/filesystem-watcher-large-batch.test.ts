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
  getSshFilesystemProvider: vi.fn()
}))

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { stat } from 'fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import type { Event as WatcherEvent } from '@parcel/watcher'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

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
    let watcherCallback: ((err: Error | null, events: WatcherEvent[]) => void) | undefined
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe: vi.fn() } as never
    })

    await handlers['fs:watchWorktree'](
      { sender: { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 } },
      { worktreePath: '/tmp/repo' }
    )

    const events = Array.from(
      { length: 200_000 },
      (_, index): WatcherEvent => ({ type: 'delete', path: `/tmp/repo/file-${index}` })
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
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/repo' })
    watcherCallback?.(
      null,
      Array.from(
        { length: 5_001 },
        (_, index): WatcherEvent => ({ type: 'update', path: `/tmp/repo/file-${index}.txt` })
      )
    )

    await vi.advanceTimersByTimeAsync(150)

    expect(stat).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: '/tmp/repo',
      events: [{ kind: 'overflow', absolutePath: '/tmp/repo' }]
    })
    await closeAllWatchers()
    vi.useRealTimers()
  })
})
