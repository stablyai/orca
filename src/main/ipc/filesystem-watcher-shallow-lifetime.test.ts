import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createWatcherSender } from './filesystem-watcher-test-sender'

const { handleMock, subscribeMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  subscribeMock: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:fs/promises', () => ({ stat: async () => ({ isDirectory: () => true }) }))
vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn()
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  onSshFilesystemProviderRegistered: () => () => {}
}))
import {
  closeAllWatchers,
  registerFilesystemWatcherHandlers,
  closeLocalWatcherForWorktreePath,
  restoreLocalWatcherAfterFailedRemoval
} from './filesystem-watcher'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'

const handlers: Record<string, (event: unknown, args: unknown) => unknown> = {}
const closes: ReturnType<typeof vi.fn>[] = []
const callbacks: ((error: Error | null, events: { type: 'update'; path: string }[]) => void)[] = []
beforeEach(async () => {
  await closeAllWatchers()
  vi.clearAllMocks()
  closes.length = 0
  callbacks.length = 0
  handleMock.mockImplementation((channel, handler) => {
    handlers[channel] = handler
  })
  subscribeMock.mockImplementation(async (_root, callback) => {
    callbacks.push(callback)
    const unsubscribe = vi.fn(async () => {})
    closes.push(unsubscribe)
    return { unsubscribe }
  })
  registerFilesystemWatcherHandlers()
})
afterEach(async () => {
  await closeAllWatchers()
  vi.useRealTimers()
})

it('keeps shallow and recursive subscriptions at the same root independently owned', async () => {
  vi.useFakeTimers()
  const sender = createWatcherSender(1)
  await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/root' })
  await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/root', shallow: true })
  expect(subscribeMock).toHaveBeenCalledTimes(2)
  expect(subscribeMock).toHaveBeenLastCalledWith(
    '/root',
    expect.any(Function),
    expect.objectContaining({ mode: 'shallow' }),
    expect.anything()
  )
  handlers['fs:unwatchWorktree']({ sender }, { worktreePath: '/root', shallow: true })
  await vi.advanceTimersByTimeAsync(30_001)
  expect(watcherLifecycleState.watchedRoots.size).toBe(1)
  expect(closes[0]).not.toHaveBeenCalled()
  expect(closes[1]).toHaveBeenCalledTimes(1)
})

it('refuses a shallow request for an SSH host instead of starting a recursive remote watch', async () => {
  const sender = createWatcherSender(1)
  await expect(
    handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/', connectionId: 'ssh', shallow: true }
    )
  ).rejects.toThrow(/shallow/i)
  expect(watcherLifecycleState.desiredRemoteWatchers.size).toBe(0)
  expect(subscribeMock).not.toHaveBeenCalled()
})

it('refuses malformed shallow remote teardown and preserves its recursive subscription intent', async () => {
  const sender = createWatcherSender(1)
  await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/', connectionId: 'ssh' })
  expect(watcherLifecycleState.desiredRemoteWatchers.size).toBe(1)
  expect(() =>
    handlers['fs:unwatchWorktree'](
      { sender },
      { worktreePath: '/', connectionId: 'ssh', shallow: true }
    )
  ).toThrow(/shallow/i)
  expect(watcherLifecycleState.desiredRemoteWatchers.size).toBe(1)
})

it('closes and restores both scope snapshots without changing their watcher modes', async () => {
  const sender = createWatcherSender(1)
  for (const shallow of [false, true]) {
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/root', shallow })
  }
  await closeLocalWatcherForWorktreePath('/root')
  expect(watcherLifecycleState.watchedRoots.size).toBe(0)
  expect(watcherLifecycleState.suspendedLocalWatcherListeners.size).toBe(2)
  expect(closes.every((close) => close.mock.calls.length === 1)).toBe(true)
  await restoreLocalWatcherAfterFailedRemoval('/root')
  expect(watcherLifecycleState.watchedRoots.size).toBe(2)
  expect(watcherLifecycleState.suspendedLocalWatcherListeners.size).toBe(0)
  expect(subscribeMock.mock.calls.map(([, , options]) => options.mode)).toEqual([
    undefined,
    'shallow',
    undefined,
    'shallow'
  ])
  expect(sender.send).toHaveBeenCalledWith('fs:changed', {
    worktreePath: '/root',
    shallow: true,
    events: [{ kind: 'overflow', absolutePath: '/root' }]
  })
})

it('coalesces unknown-entry notifications into one scoped overflow', async () => {
  vi.useFakeTimers()
  const sender = createWatcherSender(1)
  await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/root', shallow: true })
  for (let index = 0; index < 20; index++) {
    callbacks[0](null, [{ type: 'update', path: '/root' }])
  }
  await vi.advanceTimersByTimeAsync(1_000)
  expect(sender.send).toHaveBeenCalledExactlyOnceWith('fs:changed', {
    worktreePath: '/root',
    shallow: true,
    events: [{ kind: 'overflow', absolutePath: '/root' }]
  })
})

it('does not leave a failed WSL shallow install or silently substitute a recursive watch', async () => {
  const sender = createWatcherSender(1)
  await expect(
    handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '\\\\wsl.localhost\\Ubuntu\\notes', shallow: true }
    )
  ).rejects.toThrow(/shallow/i)
  expect(subscribeMock).not.toHaveBeenCalled()
  expect(watcherLifecycleState.inFlightLocalInstalls.size).toBe(0)
  expect(watcherLifecycleState.pendingLocalInstallPromises.size).toBe(0)
})
