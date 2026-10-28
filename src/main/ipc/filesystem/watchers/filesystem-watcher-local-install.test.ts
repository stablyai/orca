import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WatcherProcessFailure } from '../watcher-process/parcel-watcher-process-failure'

const { createLocalWatcherMock, createWslWatcherMock, statMock, blockedWslDistroForPathMock } =
  vi.hoisted(() => ({
    createLocalWatcherMock: vi.fn(),
    createWslWatcherMock: vi.fn(),
    statMock: vi.fn(),
    blockedWslDistroForPathMock: vi.fn(
      async (_path: string): Promise<{ distro: string; state: string } | null> => null
    )
  }))
const { noteWslDistroMayHaveStoppedMock } = vi.hoisted(() => ({
  noteWslDistroMayHaveStoppedMock: vi.fn()
}))
vi.mock('../../../wsl/wsl-unc-access-gate', () => ({
  noteWslDistroMayHaveStopped: noteWslDistroMayHaveStoppedMock,
  blockedWslDistroForPath: blockedWslDistroForPathMock
}))

vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('./filesystem-watcher-local-events', () => ({
  createLocalWatcher: createLocalWatcherMock,
  scheduleLocalBatchFlush: vi.fn()
}))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: createWslWatcherMock }))

import { installLocalWatcher } from './filesystem-watcher-local-install'
import { createDebouncedBatch } from './filesystem-watcher-batch-control'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import {
  _resetWslBackgroundDistroGateForTests,
  noteWslDistrosRunning
} from '../../../wsl-background-distro-gate'

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

describe('installLocalWatcher on a stopped WSL distro', () => {
  const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    watcherLifecycleState.unwatchableRoots.clear()
    statMock.mockReset().mockResolvedValue({ isDirectory: () => true })
    createWslWatcherMock.mockReset()
    blockedWslDistroForPathMock
      .mockReset()
      .mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    _resetWslBackgroundDistroGateForTests()
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  it('neither stats nor spawns into the distro, and retries once it runs again', async () => {
    const retry = vi.fn(async () => {})
    const scheduleRetry = vi.fn(
      (_listeners: unknown, wait?: (run: () => Promise<void>) => unknown) => wait?.(retry)
    )
    const result = await installLocalWatcher(
      UNC_ROOT,
      UNC_ROOT,
      UNC_ROOT,
      { cancelled: false, listeners: new Map(), abortController: new AbortController() },
      scheduleRetry
    )

    expect(result).toBe('capacity')
    expect(statMock).not.toHaveBeenCalled()
    expect(createWslWatcherMock).not.toHaveBeenCalled()
    // A stopped distro is not an unwatchable root: the user may start it again.
    expect(watcherLifecycleState.unwatchableRoots.has(UNC_ROOT)).toBe(false)
    expect(retry).not.toHaveBeenCalled()
    noteWslDistrosRunning(['Debian'])
    expect(retry).not.toHaveBeenCalled()
    noteWslDistrosRunning(['Ubuntu'])
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('asks for a re-watch on the distro after its watcher dies on its own', async () => {
    blockedWslDistroForPathMock.mockResolvedValue(null)
    const root = {
      listeners: new Map(),
      batch: createDebouncedBatch(),
      subscription: { unsubscribe: async () => {} }
    }
    createWslWatcherMock.mockImplementation(async (_key, _path, deps) => {
      deps.onUnexpectedStop(root, 'Ubuntu')
      return root
    })
    const retry = vi.fn(async () => {})
    const scheduleRetry = vi.fn(
      (_listeners: unknown, wait?: (run: () => Promise<void>) => unknown) => wait?.(retry)
    )
    await installLocalWatcher(
      UNC_ROOT,
      UNC_ROOT,
      UNC_ROOT,
      { cancelled: false, listeners: new Map(), abortController: new AbortController() },
      scheduleRetry
    )

    expect(noteWslDistroMayHaveStoppedMock).toHaveBeenCalledWith('Ubuntu')
    expect(scheduleRetry).toHaveBeenCalledWith(root.listeners, expect.any(Function))
    noteWslDistrosRunning(['Ubuntu'])
    expect(retry).toHaveBeenCalledTimes(1)
  })
})
