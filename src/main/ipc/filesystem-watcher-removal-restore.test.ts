import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatcherSender, fireWatcherSenderEvent } from './filesystem-watcher-test-sender'

const { handleMock, statMock, subscribeMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  statMock: vi.fn(),
  subscribeMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn()
}))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { desktopWorktreeWatcherRemoval } from './filesystem-watcher'
import { setWorktreeWatcherRemoval } from './worktree-watcher-removal'
import { createRuntimeFileWatcherRemoval } from '../runtime/runtime-file-watcher-removal'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import { resetWatcherChildRegistryForTest } from './filesystem/watcher-process/parcel-watcher-child-registry'

type Handler = (event: unknown, args: unknown) => unknown

const args = { worktreePath: '/repo' }

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    await Promise.resolve()
  }
}

describe('watcher restore after a failed worktree removal', () => {
  const handlers: Record<string, Handler> = {}
  const deferred: (() => void)[] = []
  let deferSubscribe = false
  let wedged = false
  const coordinator = createRuntimeFileWatcherRemoval({
    closeFileExplorerWatchersForPath: async () => {},
    restoreFileExplorerWatchersAfterFailedRemoval: async () => {},
    forgetFileExplorerWatchersAfterRemoval: () => {}
  })

  async function resolveAllDeferred(): Promise<void> {
    while (deferred.length > 0) {
      deferred.shift()!()
      await settle()
    }
  }

  function waitIfDeferred(signal: AbortSignal | undefined): Promise<void> {
    if (!deferSubscribe) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const done = (): void => {
        signal?.removeEventListener('abort', abort)
        resolve()
      }
      const abort = (): void => {
        deferred.splice(deferred.indexOf(done), 1)
        reject(new Error('aborted'))
      }
      deferred.push(done)
      if (!wedged) {
        signal?.addEventListener('abort', abort, { once: true })
      }
    })
  }

  beforeEach(async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    resetWatcherChildRegistryForTest()
    setWorktreeWatcherRemoval(desktopWorktreeWatcherRemoval)
    deferSubscribe = false
    wedged = false
    deferred.length = 0
    handleMock.mockImplementation((channel: string, handler: Handler) => {
      handlers[channel] = handler
    })
    statMock.mockResolvedValue({ isDirectory: () => true })
    subscribeMock.mockImplementation(
      async (_dir: string, _cb: unknown, _opts: unknown, hooks?: { signal?: AbortSignal }) => {
        await waitIfDeferred(hooks?.signal)
        return { unsubscribe: vi.fn(async () => {}) }
      }
    )
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  afterEach(async () => {
    await resolveAllDeferred()
    await closeAllWatchers()
    setWorktreeWatcherRemoval(null)
    resetWatcherChildRegistryForTest()
    vi.restoreAllMocks()
  })

  const listeners = (): number[] => [
    ...(watcherLifecycleState.watchedRoots
      .get(getLocalWatcherRoot('/repo').key)
      ?.listeners.keys() ?? [])
  ]

  it('drops a window that unwatches while an earlier window is being restored', async () => {
    const first = createWatcherSender(1)
    const second = createWatcherSender(2)
    await handlers['fs:watchWorktree']({ sender: first }, args)
    await handlers['fs:watchWorktree']({ sender: second }, args)
    const removal = await coordinator.acquire(args.worktreePath)

    deferSubscribe = true
    const restoring = removal.finish(false)
    await settle()
    handlers['fs:unwatchWorktree']({ sender: second }, args)
    await resolveAllDeferred()
    await restoring

    expect(listeners()).toEqual([1])
    expect(watcherLifecycleState.suspendedLocalWatcherListeners.size).toBe(0)
  })

  it('keeps a retried removal’s owners when it overlaps the previous restore', async () => {
    const first = createWatcherSender(1)
    const second = createWatcherSender(2)
    await handlers['fs:watchWorktree']({ sender: first }, args)
    await handlers['fs:watchWorktree']({ sender: second }, args)
    const firstRemoval = await coordinator.acquire(args.worktreePath)

    // Retry removal while the first restore is re-subscribing window 1.
    deferSubscribe = true
    const firstRestore = firstRemoval.finish(false)
    await settle()
    const secondAcquire = coordinator.acquire(args.worktreePath)
    await settle()
    await resolveAllDeferred()
    const secondRemoval = await secondAcquire
    await firstRestore

    deferSubscribe = false
    await secondRemoval.finish(false)
    await settle()

    expect(listeners().sort()).toEqual([1, 2])
    expect(watcherLifecycleState.suspendedLocalWatcherListeners.size).toBe(0)
  })

  it('keeps a window that reloads (same id) while overlapping restores run', async () => {
    const first = createWatcherSender(1)
    const second = createWatcherSender(2)
    // A third owner keeps the old snapshot nonempty after window 2 reloads.
    const third = createWatcherSender(3)
    for (const sender of [first, second, third]) {
      await handlers['fs:watchWorktree']({ sender }, args)
    }
    const firstRemoval = await coordinator.acquire(args.worktreePath)

    deferSubscribe = true
    const firstRestore = firstRemoval.finish(false)
    await settle()
    // Reload preserves window ID but creates a new watch lifetime.
    fireWatcherSenderEvent(second, 'did-navigate')
    const rewatch = Promise.resolve(handlers['fs:watchWorktree']({ sender: second }, args))
    await settle()
    const secondAcquire = coordinator.acquire(args.worktreePath)
    await settle()
    await resolveAllDeferred()
    const secondRemoval = await secondAcquire
    await firstRestore
    await rewatch.catch(() => {})

    deferSubscribe = false
    await secondRemoval.finish(false)
    await settle()

    expect(listeners().sort()).toEqual([1, 2, 3])
  })

  it('restores a window that was waiting out a cancelled install when removal began', async () => {
    const sender = createWatcherSender(1)
    deferSubscribe = true
    wedged = true
    const first = Promise.resolve(handlers['fs:watchWorktree']({ sender }, args))
    await settle()
    handlers['fs:unwatchWorktree']({ sender }, args)
    await settle()
    // Re-watch waits outside listener maps until the aborted install retires.
    deferSubscribe = false
    const second = Promise.resolve(handlers['fs:watchWorktree']({ sender }, args))
    await settle()
    const acquiring = coordinator.acquire(args.worktreePath)
    await settle()
    await resolveAllDeferred()
    const removal = await acquiring
    await Promise.allSettled([first, second])
    await removal.finish(false)
    await settle()

    expect(listeners()).toEqual([1])
  })
})
