import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, getSshFilesystemProviderMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock }
}))

vi.mock('fs/promises', () => ({ stat: vi.fn() }))
vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  onSshFilesystemProviderRegistered: () => () => {}
}))

import { WATCH_ROOT_CAPACITY_REFUSAL_MESSAGE } from '../../shared/watch-root-capacity-refusal'
import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getRemoteWatcherKey } from './filesystem-watcher-paths'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('remote filesystem watcher capacity refusals', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    handleMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  afterEach(async () => {
    for (const dormant of watcherLifecycleState.dormantRemoteWatchers.values()) {
      clearTimeout(dormant.timer)
    }
    watcherLifecycleState.dormantRemoteWatchers.clear()
    await closeAllWatchers()
    vi.useRealTimers()
  })

  // A folder workspace with more repos than the relay's watch-root cap leaves every excess root
  // permanently refused; the 1 Hz unavailable ladder then bills the relay one install per root per
  // second, which is the load that pinned it (#11196).
  it('does not retry a relay watch-root capacity refusal on the fast ladder', async () => {
    vi.useFakeTimers()
    const watchMock = vi.fn(async () => {
      throw new Error(WATCH_ROOT_CAPACITY_REFUSAL_MESSAGE)
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const args = { worktreePath: '/home/me/repos/one', connectionId: 'conn-capacity' }

    await handlers['fs:watchWorktree']({ sender }, args)
    const key = getRemoteWatcherKey(args.connectionId, args.worktreePath)

    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(watcherLifecycleState.pendingRemoteWatcherRetries.has(key)).toBe(false)
    expect(watcherLifecycleState.dormantRemoteWatchers.has(key)).toBe(true)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(watchMock).toHaveBeenCalledTimes(1)
  })

  it('still retries an ordinary unavailable install on the fast ladder', async () => {
    vi.useFakeTimers()
    const watchMock = vi.fn(async () => {
      throw new Error('Relay channel lost')
    })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const args = { worktreePath: '/home/me/repos/two', connectionId: 'conn-unavailable' }

    await handlers['fs:watchWorktree']({ sender }, args)
    const key = getRemoteWatcherKey(args.connectionId, args.worktreePath)

    expect(watcherLifecycleState.pendingRemoteWatcherRetries.has(key)).toBe(true)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(watchMock.mock.calls.length).toBeGreaterThan(1)
  })
})
