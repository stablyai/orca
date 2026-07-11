import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { createWslWatcherMock, handleMock } = vi.hoisted(() => ({
  createWslWatcherMock: vi.fn(),
  handleMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('fs/promises', () => ({ stat: vi.fn() }))
vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: createWslWatcherMock }))
vi.mock('../wsl', () => ({ isWslPath: () => true }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn()
}))

import {
  closeAllWatchers,
  closeLocalWatcherForWorktreePath,
  registerFilesystemWatcherHandlers
} from './filesystem-watcher'
import { stat } from 'node:fs/promises'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

const WORKTREE = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'

function sender(id: number) {
  return { id, isDestroyed: () => false, once: vi.fn(), send: vi.fn() }
}

function root(unsubscribe: () => Promise<void> = async () => undefined) {
  return {
    subscription: { unsubscribe },
    listeners: new Map(),
    batch: { events: [], overflowed: false, timer: null, firstEventAt: 0 }
  }
}

describe('pending WSL watcher lifecycle', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
    createWslWatcherMock.mockReset()
    vi.mocked(stat)
      .mockReset()
      .mockResolvedValue({ isDirectory: () => true } as never)
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
    vi.useRealTimers()
    vi.restoreAllMocks()
    await closeAllWatchers()
  })

  it('aborts the final pending listener and lets a later listener retry', async () => {
    let firstSignal!: AbortSignal
    createWslWatcherMock
      .mockImplementationOnce((_root, _path, deps) => {
        firstSignal = deps.signal
        return new Promise((_resolve, reject) => {
          deps.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
            once: true
          })
        })
      })
      .mockResolvedValueOnce(root())
    const firstSender = sender(1)
    const firstWatch = handlers['fs:watchWorktree'](
      { sender: firstSender },
      { worktreePath: WORKTREE }
    ) as Promise<unknown>
    await vi.waitFor(() => expect(createWslWatcherMock).toHaveBeenCalledOnce())

    handlers['fs:unwatchWorktree']({ sender: firstSender }, { worktreePath: WORKTREE })
    expect(firstSignal.aborted).toBe(true)
    const secondSender = sender(2)
    const secondWatch = handlers['fs:watchWorktree'](
      { sender: secondSender },
      { worktreePath: WORKTREE }
    ) as Promise<unknown>
    await Promise.all([firstWatch, secondWatch])
    expect(createWslWatcherMock).toHaveBeenCalledTimes(2)
  })

  it('releases a final-unwatched install after its deferred stat settles', async () => {
    let resolveStat!: () => void
    vi.mocked(stat)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStat = () => resolve({ isDirectory: () => true } as never)
          })
      )
      .mockResolvedValue({ isDirectory: () => true } as never)
    let retrySignal!: AbortSignal
    createWslWatcherMock.mockImplementation(async (_root, _path, deps) => {
      retrySignal = deps.signal
      return root()
    })
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort')
    const firstSender = sender(1)
    const firstWatch = handlers['fs:watchWorktree'](
      { sender: firstSender },
      { worktreePath: WORKTREE }
    ) as Promise<unknown>
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())

    handlers['fs:unwatchWorktree']({ sender: firstSender }, { worktreePath: WORKTREE })
    expect(abortSpy).toHaveBeenCalledOnce()
    resolveStat()
    await firstWatch

    handlers['fs:unwatchWorktree']({ sender: firstSender }, { worktreePath: WORKTREE })
    expect(abortSpy).toHaveBeenCalledOnce()
    await handlers['fs:watchWorktree']({ sender: sender(2) }, { worktreePath: WORKTREE })
    expect(createWslWatcherMock).toHaveBeenCalledOnce()
    expect(retrySignal.aborted).toBe(false)
  })

  it('releases a deferred-stat install across closeAll and allows a clean retry', async () => {
    let resolveStat!: () => void
    vi.mocked(stat)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStat = () => resolve({ isDirectory: () => true } as never)
          })
      )
      .mockResolvedValue({ isDirectory: () => true } as never)
    let retrySignal!: AbortSignal
    createWslWatcherMock.mockImplementation(async (_root, _path, deps) => {
      retrySignal = deps.signal
      return root()
    })
    const abortSpy = vi.spyOn(AbortController.prototype, 'abort')
    const retrySender = sender(1)
    const firstWatch = handlers['fs:watchWorktree'](
      { sender: retrySender },
      { worktreePath: WORKTREE }
    ) as Promise<unknown>
    await vi.waitFor(() => expect(stat).toHaveBeenCalledOnce())

    const shutdown = closeAllWatchers()
    expect(abortSpy).toHaveBeenCalledOnce()
    resolveStat()
    await Promise.all([firstWatch, shutdown])
    await closeAllWatchers()
    expect(abortSpy).toHaveBeenCalledOnce()

    await handlers['fs:watchWorktree']({ sender: retrySender }, { worktreePath: WORKTREE })
    expect(retrySender.once).toHaveBeenCalledTimes(2)
    expect(createWslWatcherMock).toHaveBeenCalledOnce()
    expect(retrySignal.aborted).toBe(false)
  })

  it('aborts and awaits an explicitly closed pending watcher', async () => {
    let signal!: AbortSignal
    createWslWatcherMock.mockImplementation((_root, _path, deps) => {
      signal = deps.signal
      return new Promise((_resolve, reject) => {
        deps.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
      })
    })
    const watch = handlers['fs:watchWorktree'](
      { sender: sender(1) },
      { worktreePath: WORKTREE }
    ) as Promise<unknown>
    await vi.waitFor(() => expect(createWslWatcherMock).toHaveBeenCalledOnce())

    await closeLocalWatcherForWorktreePath(WORKTREE)
    expect(signal.aborted).toBe(true)
    await watch
  })

  it('awaits shutdown cancellation and the resulting unsubscribe drain', async () => {
    let signal!: AbortSignal
    let resolveInstall!: (value: ReturnType<typeof root>) => void
    let resolveUnsubscribe!: () => void
    const unsubscribe = vi.fn(() => new Promise<void>((resolve) => (resolveUnsubscribe = resolve)))
    createWslWatcherMock.mockImplementation((_root, _path, deps) => {
      signal = deps.signal
      return new Promise((resolve) => {
        resolveInstall = resolve
      })
    })
    const watch = handlers['fs:watchWorktree'](
      { sender: sender(1) },
      { worktreePath: WORKTREE }
    ) as Promise<unknown>
    await vi.waitFor(() => expect(createWslWatcherMock).toHaveBeenCalledOnce())

    let closed = false
    const shutdown = closeAllWatchers().then(() => (closed = true))
    expect(signal.aborted).toBe(true)
    expect(closed).toBe(false)
    resolveInstall(root(unsubscribe))
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce())
    expect(closed).toBe(false)

    resolveUnsubscribe()
    await Promise.all([watch, shutdown])
    expect(closed).toBe(true)
  })

  it('pauses sustained listenerless events and flushes them once after reattach', async () => {
    vi.useFakeTimers()
    const watchedRoot = root()
    let schedule!: (rootKey: string, watched: typeof watchedRoot) => void
    createWslWatcherMock.mockImplementation(async (_root, _path, deps) => {
      schedule = deps.scheduleBatchFlush
      return watchedRoot
    })
    const firstSender = sender(1)
    await handlers['fs:watchWorktree']({ sender: firstSender }, { worktreePath: WORKTREE })
    handlers['fs:unwatchWorktree']({ sender: firstSender }, { worktreePath: WORKTREE })

    for (let index = 0; index < 100; index += 1) {
      watchedRoot.batch.events.push({ type: 'update', path: `${WORKTREE}\\README.md` } as never)
      schedule(WORKTREE, watchedRoot)
      await vi.advanceTimersByTimeAsync(10)
    }
    expect(firstSender.send).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    const secondSender = sender(2)
    await handlers['fs:watchWorktree']({ sender: secondSender }, { worktreePath: WORKTREE })
    await vi.advanceTimersByTimeAsync(150)
    expect(secondSender.send).toHaveBeenCalledTimes(1)
  })
})
