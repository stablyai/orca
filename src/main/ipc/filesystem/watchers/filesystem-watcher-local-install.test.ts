import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WatcherProcessFailure } from '../watcher-process/parcel-watcher-process-failure'

const { createLocalWatcherMock, statMock } = vi.hoisted(() => ({
  createLocalWatcherMock: vi.fn(),
  statMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('./filesystem-watcher-local-events', () => ({
  createLocalWatcher: createLocalWatcherMock,
  scheduleLocalBatchFlush: vi.fn()
}))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))

import { installLocalWatcher } from './filesystem-watcher-local-install'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'

function install(rootKey: string): ReturnType<typeof installLocalWatcher> {
  return installLocalWatcher(
    rootKey,
    rootKey,
    rootKey,
    { cancelled: false, listeners: new Map(), abortController: new AbortController() },
    vi.fn()
  )
}

describe('installLocalWatcher failure caching', () => {
  beforeEach(() => {
    watcherLifecycleState.unwatchableRoots.clear()
    statMock.mockReset().mockResolvedValue({ isDirectory: () => true })
    createLocalWatcherMock.mockReset()
  })

  it.each(['supervisor_crash_fuse', 'process_unavailable'] as const)(
    'does not remember a root that failed with %s so it retries after the fuse half-opens',
    async (code) => {
      createLocalWatcherMock.mockRejectedValue(
        new WatcherProcessFailure('fuse open', 'supervisor', code)
      )

      await expect(install('/repo')).resolves.toBe('unavailable')

      expect(watcherLifecycleState.unwatchableRoots.has('/repo')).toBe(false)
    }
  )

  it('still remembers a root whose native subscribe failed', async () => {
    createLocalWatcherMock.mockRejectedValue(
      new WatcherProcessFailure('EACCES', 'subscription', 'subscribe_failed')
    )

    await expect(install('/repo')).resolves.toBe('unavailable')

    expect(watcherLifecycleState.unwatchableRoots.has('/repo')).toBe(true)
  })
})
