import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, subscribeMock, stallListener } = vi.hoisted(() => {
  const stallListener: { current: ((stalled: boolean) => void) | null } = { current: null }
  return { handleMock: vi.fn(), subscribeMock: vi.fn(), stallListener }
})

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('fs/promises', () => ({ stat: vi.fn(async () => ({ isDirectory: () => true })) }))
vi.mock('../watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn(),
  setSharedWatcherDeliveryStallListener: (listener: (stalled: boolean) => void) => {
    stallListener.current = listener
  }
}))

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { WatcherProcessFailure } from '../watcher-process/parcel-watcher-process-failure'

type WatchCallback = (err: Error | null, events: unknown[]) => void
type WatchHandler = (event: unknown, args: unknown) => Promise<void>

function createWatcherSender(id: number) {
  return { id, isDestroyed: () => false, send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
}

function pauseMessages(sender: ReturnType<typeof createWatcherSender>): unknown[] {
  return sender.send.mock.calls
    .filter(([channel]) => channel === 'fs:watchPaused')
    .map(([, payload]) => payload)
}

const fuseOpen = (): WatcherProcessFailure =>
  new WatcherProcessFailure('watcher unavailable', 'supervisor', 'process_unavailable')

describe('local watch pause signal', () => {
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

  it('tells a window joining a healthy root that it is not paused', async () => {
    subscribeMock.mockResolvedValue({ unsubscribe: vi.fn().mockResolvedValue(undefined) })
    const sender = createWatcherSender(1)
    await watchWorktree({ sender }, { worktreePath: '/repo' })
    expect(pauseMessages(sender)).toEqual([{ worktreePath: '/repo', paused: false }])
  })

  it('pauses during the crash-fuse cooldown and resumes once the rewatch installs', async () => {
    vi.useFakeTimers()
    subscribeMock
      .mockRejectedValueOnce(fuseOpen())
      .mockResolvedValue({ unsubscribe: vi.fn().mockResolvedValue(undefined) })
    const sender = createWatcherSender(1)
    await watchWorktree({ sender }, { worktreePath: '/repo' })
    expect(pauseMessages(sender)).toEqual([{ worktreePath: '/repo', paused: true }])

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(pauseMessages(sender)).toEqual([
      { worktreePath: '/repo', paused: true },
      { worktreePath: '/repo', paused: false }
    ])
  })

  it('pauses an installed root whose watch the crash fuse dropped', async () => {
    vi.useFakeTimers()
    const callbacks: WatchCallback[] = []
    subscribeMock.mockImplementation(async (_dir: string, callback: WatchCallback) => {
      callbacks.push(callback)
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) }
    })
    const sender = createWatcherSender(1)
    await watchWorktree({ sender }, { worktreePath: '/repo' })
    callbacks[0](
      new WatcherProcessFailure('crashed repeatedly', 'supervisor', 'supervisor_crash_fuse'),
      []
    )
    expect(pauseMessages(sender)).toEqual([
      { worktreePath: '/repo', paused: false },
      { worktreePath: '/repo', paused: true }
    ])
  })

  it('tells a window that joins while paused, without a second flip', async () => {
    vi.useFakeTimers()
    subscribeMock.mockRejectedValue(fuseOpen())
    const first = createWatcherSender(1)
    await watchWorktree({ sender: first }, { worktreePath: '/repo' })
    const second = createWatcherSender(2)
    await watchWorktree({ sender: second }, { worktreePath: '/repo' })
    expect(pauseMessages(second)).toContainEqual({ worktreePath: '/repo', paused: true })
    // The joining subscribe retried through an install, which must not flicker "resumed".
    expect(pauseMessages(first)).not.toContainEqual({ worktreePath: '/repo', paused: false })
  })

  it('pauses installed roots while OS event delivery is stalled', async () => {
    subscribeMock.mockResolvedValue({ unsubscribe: vi.fn().mockResolvedValue(undefined) })
    const sender = createWatcherSender(1)
    await watchWorktree({ sender }, { worktreePath: '/repo' })
    stallListener.current?.(true)
    stallListener.current?.(false)
    expect(pauseMessages(sender)).toEqual([
      { worktreePath: '/repo', paused: false },
      { worktreePath: '/repo', paused: true },
      { worktreePath: '/repo', paused: false }
    ])
  })

  it('pauses a root dropped by a non-fuse watcher error', async () => {
    const callbacks: WatchCallback[] = []
    subscribeMock.mockImplementation(async (_dir: string, callback: WatchCallback) => {
      callbacks.push(callback)
      return { unsubscribe: vi.fn().mockResolvedValue(undefined) }
    })
    const sender = createWatcherSender(1)
    await watchWorktree({ sender }, { worktreePath: '/repo' })
    callbacks[0](new Error('root deleted'), [])
    expect(pauseMessages(sender)).toEqual([
      { worktreePath: '/repo', paused: false },
      { worktreePath: '/repo', paused: true }
    ])

    // Resubscribing installs a fresh root, which supersedes the error.
    await watchWorktree({ sender }, { worktreePath: '/repo' })
    expect(pauseMessages(sender).at(-1)).toEqual({ worktreePath: '/repo', paused: false })
  })

  it('resumes windows carried by an install whose own window went away', async () => {
    vi.useFakeTimers()
    subscribeMock
      .mockRejectedValueOnce(fuseOpen())
      .mockResolvedValue({ unsubscribe: vi.fn().mockResolvedValue(undefined) })
    const waiting = createWatcherSender(1)
    await watchWorktree({ sender: waiting }, { worktreePath: '/repo' })
    // A second window's subscribe folds the waiting window into its own install, then reloads.
    let destroyed = false
    const leaving = { ...createWatcherSender(2), isDestroyed: () => destroyed }
    const install = watchWorktree({ sender: leaving }, { worktreePath: '/repo' })
    destroyed = true
    await install
    expect(pauseMessages(waiting)).toContainEqual({ worktreePath: '/repo', paused: false })
  })
})
