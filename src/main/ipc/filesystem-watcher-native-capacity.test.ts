import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, statMock, subscribeViaWatcherProcessMock, disposeWatcherProcessMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    statMock: vi.fn(),
    subscribeViaWatcherProcessMock: vi.fn(),
    disposeWatcherProcessMock: vi.fn()
  }))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeViaWatcherProcessMock,
  disposeWatcherProcess: disposeWatcherProcessMock
}))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn()
}))

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'
import {
  MAX_PHYSICAL_WATCHER_CHILDREN,
  reserveWatcherChild,
  resetWatcherChildRegistryForTest,
  WatcherChildCapacityError
} from './parcel-watcher-child-registry'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

function fillWatcherChildCapacity(): (() => void)[] {
  return Array.from({ length: MAX_PHYSICAL_WATCHER_CHILDREN }, () => {
    const release = reserveWatcherChild()
    if (!release) {
      throw new Error('expected watcher child reservation')
    }
    return release
  })
}

describe('native filesystem watcher capacity recovery', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    handleMock.mockReset()
    statMock.mockReset()
    subscribeViaWatcherProcessMock.mockReset()
    disposeWatcherProcessMock.mockReset()
    resetWatcherChildRegistryForTest()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    statMock.mockResolvedValue({ isDirectory: () => true })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  afterEach(async () => {
    await closeAllWatchers()
    resetWatcherChildRegistryForTest()
  })

  it('automatically retries a native root when a child slot is released', async () => {
    const releases = fillWatcherChildCapacity()
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    subscribeViaWatcherProcessMock
      .mockRejectedValueOnce(new WatcherChildCapacityError())
      .mockResolvedValueOnce({ unsubscribe })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const args = { worktreePath: '/tmp/native-capacity-root' }

    await handlers['fs:watchWorktree']({ sender }, args)
    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledOnce()

    releases.pop()?.()
    await vi.waitFor(() => expect(subscribeViaWatcherProcessMock).toHaveBeenCalledTimes(2))

    releases.forEach((release) => release())
  })

  it('cancels the native capacity wait when its renderer unwatches', async () => {
    const releases = fillWatcherChildCapacity()
    subscribeViaWatcherProcessMock.mockRejectedValue(new WatcherChildCapacityError())
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const args = { worktreePath: '/tmp/native-capacity-root' }

    await handlers['fs:watchWorktree']({ sender }, args)
    handlers['fs:unwatchWorktree']({ sender: { id: sender.id } }, args)
    releases.pop()?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledOnce()
    releases.forEach((release) => release())
  })
})
