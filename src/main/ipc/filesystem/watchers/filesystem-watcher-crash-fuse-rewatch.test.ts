import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, subscribeMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  subscribeMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('fs/promises', () => ({ stat: vi.fn(async () => ({ isDirectory: () => true })) }))
vi.mock('../watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn()
}))

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { WatcherProcessFailure } from '../watcher-process/parcel-watcher-process-failure'

type WatchCallback = (err: Error | null, events: unknown[]) => void

function createWatcherSender(id: number) {
  return { id, isDestroyed: () => false, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}
type WatchHandler = (event: unknown, args: unknown) => Promise<void>

describe('local watcher after the crash fuse opens', () => {
  let watchWorktree: WatchHandler

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
    subscribeMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: WatchHandler) => {
      if (channel === 'fs:watchWorktree') {
        watchWorktree = handler
      }
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  afterEach(async () => {
    vi.useRealTimers()
    await closeAllWatchers()
  })

  it('rewatches the root after the cooldown and resyncs the renderer', async () => {
    vi.useFakeTimers()
    const callbacks: WatchCallback[] = []
    subscribeMock.mockImplementation(async (_dir: string, callback: WatchCallback) => {
      callbacks.push(callback)
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) }
    })
    const sender = createWatcherSender(1)
    await watchWorktree({ sender }, { worktreePath: '/repo' })
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    callbacks[0](
      new WatcherProcessFailure('crashed repeatedly', 'supervisor', 'supervisor_crash_fuse'),
      []
    )
    sender.send.mockClear()
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: '/repo',
      events: [{ kind: 'overflow', absolutePath: '/repo' }],
      resync: true
    })
  })

  it('keeps waiting while the fuse stays open and resyncs once it closes', async () => {
    vi.useFakeTimers()
    const fuseOpen = new WatcherProcessFailure(
      'watcher unavailable',
      'supervisor',
      'process_unavailable'
    )
    subscribeMock
      .mockRejectedValueOnce(fuseOpen)
      .mockRejectedValueOnce(fuseOpen)
      .mockResolvedValue({ unsubscribe: vi.fn().mockResolvedValue(undefined) })
    const sender = createWatcherSender(1)
    await watchWorktree({ sender }, { worktreePath: '/repo' })
    expect(subscribeMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1)
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(sender.send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(subscribeMock).toHaveBeenCalledTimes(3)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: '/repo',
      events: [{ kind: 'overflow', absolutePath: '/repo' }],
      resync: true
    })
  })
})
