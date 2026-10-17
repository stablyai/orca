import { createWatcherSender } from './filesystem-watcher-test-sender'
import { statSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: vi.fn(),
  disposeWatcherProcess: vi.fn()
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
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('filesystem watcher unwatchable root cache', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    handleMock.mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(subscribeViaWatcherProcess).mockReset()
    vi.mocked(subscribeViaWatcherProcess).mockResolvedValue({ unsubscribe: vi.fn() })
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  it('releases the install record when the root is a file', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createWatcherSender(1)
    vi.mocked(stat).mockResolvedValue(statSync(new URL(import.meta.url)))
    try {
      await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/not-directory' })
      expect(watcherLifecycleState.inFlightLocalInstalls.size).toBe(0)
      expect(watcherLifecycleState.pendingLocalInstallPromises.size).toBe(0)
    } finally {
      warnSpy.mockRestore()
      await closeAllWatchers()
    }
  })

  it('evicts oldest failed local roots while suppressing recent retries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createWatcherSender(1)
    vi.mocked(stat).mockRejectedValue(new Error('missing'))

    for (let i = 0; i < 257; i += 1) {
      await handlers['fs:watchWorktree']({ sender }, { worktreePath: `/tmp/missing-${i}` })
    }
    expect(stat).toHaveBeenCalledTimes(257)
    expect(watcherLifecycleState.inFlightLocalInstalls.size).toBe(0)
    expect(watcherLifecycleState.pendingLocalInstallPromises.size).toBe(0)

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/missing-0' })
    expect(stat).toHaveBeenCalledTimes(258)

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/missing-256' })
    expect(stat).toHaveBeenCalledTimes(258)

    warnSpy.mockRestore()
    await closeAllWatchers()
  })

  it('retries a failed root after explicit unwatch without retrying repeated subscriptions', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createWatcherSender(1)
    const worktreePath = join(tmpdir(), 'orca-transient-watch-root')
    const rootKey = getLocalWatcherRoot(worktreePath).key
    vi.mocked(stat).mockRejectedValueOnce(new Error('transient'))
    vi.mocked(stat).mockResolvedValue(statSync(tmpdir()))
    try {
      await handlers['fs:watchWorktree']({ sender }, { worktreePath })
      await handlers['fs:watchWorktree']({ sender }, { worktreePath })
      expect(stat).toHaveBeenCalledTimes(1)
      expect(subscribeViaWatcherProcess).not.toHaveBeenCalled()

      await handlers['fs:unwatchWorktree']({ sender }, { worktreePath })
      await handlers['fs:watchWorktree']({ sender }, { worktreePath })
      expect(stat).toHaveBeenCalledTimes(2)
      expect(watcherLifecycleState.watchedRoots.get(rootKey)?.listeners.has(sender.id)).toBe(true)
      expect(watcherLifecycleState.unwatchableRoots.has(rootKey)).toBe(false)
    } finally {
      warnSpy.mockRestore()
      await closeAllWatchers()
    }
  })

  it('keeps failed local suppression when an SSH watch of the same path is closed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createWatcherSender(1)
    const worktreePath = join(tmpdir(), 'orca-transient-watch-root')
    vi.mocked(stat).mockRejectedValue(new Error('transient'))
    try {
      await handlers['fs:watchWorktree']({ sender }, { worktreePath })
      await handlers['fs:unwatchWorktree']({ sender }, { worktreePath, connectionId: 'remote' })
      await handlers['fs:watchWorktree']({ sender }, { worktreePath })
      expect(stat).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
      await closeAllWatchers()
    }
  })

  it('does not cache a late stat failure from an explicitly cancelled install', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createWatcherSender(1)
    const worktreePath = join(tmpdir(), 'orca-transient-watch-root')
    const rootKey = getLocalWatcherRoot(worktreePath).key
    let rejectStat: ((reason: Error) => void) | undefined
    vi.mocked(stat).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStat = reject
        })
    )
    vi.mocked(stat).mockResolvedValue(statSync(tmpdir()))
    try {
      const pending = handlers['fs:watchWorktree']({ sender }, { worktreePath })
      expect(rejectStat).toBeDefined()
      await handlers['fs:unwatchWorktree']({ sender }, { worktreePath })
      rejectStat?.(new Error('late transient'))
      await pending
      await handlers['fs:watchWorktree']({ sender }, { worktreePath })
      expect(stat).toHaveBeenCalledTimes(2)
      expect(watcherLifecycleState.watchedRoots.has(rootKey)).toBe(true)
      expect(watcherLifecycleState.unwatchableRoots.has(rootKey)).toBe(false)
    } finally {
      warnSpy.mockRestore()
      await closeAllWatchers()
    }
  })

  it('does not cache non-directory metadata received after the install was cancelled', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = createWatcherSender(1)
    const worktreePath = join(tmpdir(), 'orca-transient-watch-root')
    const rootKey = getLocalWatcherRoot(worktreePath).key
    let resolveStat: ((stats: Stats) => void) | undefined
    vi.mocked(stat).mockImplementationOnce(
      () =>
        new Promise<Stats>((resolve) => {
          resolveStat = resolve
        })
    )
    vi.mocked(stat).mockResolvedValue(statSync(tmpdir()))
    try {
      const pending = handlers['fs:watchWorktree']({ sender }, { worktreePath })
      expect(resolveStat).toBeDefined()
      await handlers['fs:unwatchWorktree']({ sender }, { worktreePath })
      resolveStat?.(statSync(new URL(import.meta.url)))
      await pending
      await handlers['fs:watchWorktree']({ sender }, { worktreePath })
      expect(stat).toHaveBeenCalledTimes(2)
      expect(watcherLifecycleState.watchedRoots.has(rootKey)).toBe(true)
      expect(watcherLifecycleState.unwatchableRoots.has(rootKey)).toBe(false)
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
      await closeAllWatchers()
    }
  })

  it('reopens once for a new listener waiting on a cancelled failed stat', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const oldSender = createWatcherSender(1)
    const newSender = createWatcherSender(2)
    const worktreePath = join(tmpdir(), 'orca-transient-watch-root')
    const rootKey = getLocalWatcherRoot(worktreePath).key
    let rejectStat: ((reason: Error) => void) | undefined
    vi.mocked(stat).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectStat = reject
        })
    )
    vi.mocked(stat).mockResolvedValue(statSync(tmpdir()))
    try {
      const oldWatch = handlers['fs:watchWorktree']({ sender: oldSender }, { worktreePath })
      await handlers['fs:unwatchWorktree']({ sender: oldSender }, { worktreePath })
      const newWatch = handlers['fs:watchWorktree']({ sender: newSender }, { worktreePath })
      rejectStat?.(new Error('late transient'))
      await Promise.all([oldWatch, newWatch])
      expect(stat).toHaveBeenCalledTimes(2)
      expect(subscribeViaWatcherProcess).toHaveBeenCalledTimes(1)
      expect([
        ...(watcherLifecycleState.watchedRoots.get(rootKey)?.listeners.keys() ?? [])
      ]).toEqual([newSender.id])
      expect(watcherLifecycleState.unwatchableRoots.has(rootKey)).toBe(false)
    } finally {
      warnSpy.mockRestore()
      await closeAllWatchers()
    }
  })
})
