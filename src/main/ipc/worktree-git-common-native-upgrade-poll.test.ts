import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import { GIT_COMMON_NATIVE_UPGRADE_INTERVAL_MS } from './worktree-git-common-native-upgrade-poll'

const { pollingMock, statMock, subscribeMock } = vi.hoisted(() => ({
  pollingMock: vi.fn(),
  statMock: vi.fn(),
  subscribeMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('./parcel-watcher-process', () => ({ subscribeViaWatcherProcess: subscribeMock }))
vi.mock('./worktree-git-common-polling', () => ({ startGitCommonPolling: pollingMock }))

import { startGitCommonNarrowWatch } from './worktree-git-common-narrow-watch'

const visibility = {
  isWindowVisible: () => true,
  onWindowBecameVisible: () => () => {}
}

const fuseFailure = (): WatcherProcessFailure =>
  new WatcherProcessFailure('fuse open', 'supervisor', 'process_unavailable')

describe('git-common narrow watch crash-fuse upgrade poll', () => {
  const pollers: { unsubscribe: ReturnType<typeof vi.fn> }[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    pollers.length = 0
    statMock.mockReset().mockResolvedValue({ isDirectory: () => true })
    subscribeMock.mockReset()
    pollingMock.mockReset().mockImplementation(async () => {
      const poller = { unsubscribe: vi.fn(async () => undefined) }
      pollers.push(poller)
      return poller
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns to native events once the watcher process is available again', async () => {
    subscribeMock.mockRejectedValue(fuseFailure())
    const onEvents = vi.fn()
    const watch = await startGitCommonNarrowWatch(
      { key: '/repo/.git', kind: 'git-common', path: '/repo/.git', repos: new Map() },
      onEvents,
      2_000,
      'darwin',
      visibility
    )
    const fallback = pollers[0]
    expect(fallback).toBeDefined()

    // Fuse still open: the slow retry keeps the poller.
    await vi.advanceTimersByTimeAsync(GIT_COMMON_NATIVE_UPGRADE_INTERVAL_MS)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(fallback.unsubscribe).not.toHaveBeenCalled()
    expect(pollers).toHaveLength(1)

    const nativeUnsubscribe = vi.fn(async () => undefined)
    subscribeMock.mockResolvedValue({ unsubscribe: nativeUnsubscribe })
    await vi.advanceTimersByTimeAsync(GIT_COMMON_NATIVE_UPGRADE_INTERVAL_MS)

    expect(subscribeMock).toHaveBeenCalledTimes(3)
    expect(fallback.unsubscribe).toHaveBeenCalledOnce()
    expect(onEvents).toHaveBeenCalledWith([{ type: 'update', path: '/repo/.git/worktrees' }])

    // Native again: no further upgrade attempts.
    await vi.advanceTimersByTimeAsync(GIT_COMMON_NATIVE_UPGRADE_INTERVAL_MS * 2)
    expect(subscribeMock).toHaveBeenCalledTimes(3)

    await watch.unsubscribe()
    expect(nativeUnsubscribe).toHaveBeenCalledOnce()
  })
})
