import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('./filesystem-watcher-wsl', () => ({
  createWslWatcher: vi.fn()
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn()
}))

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { stat } from 'fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

describe('local filesystem watcher unsubscribe cleanup', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    handleMock.mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(subscribeParcelWatcher).mockReset()
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
    await closeAllWatchers()
  })

  it('awaits an unsubscribe already started by sender cleanup during shutdown', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let resolveUnsubscribe: () => void = () => {}
    const unsubscribeMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnsubscribe = resolve
        })
    )
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: unsubscribeMock } as never)
    const destroyedCallbacks: (() => void)[] = []
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'destroyed') {
          destroyedCallbacks.push(callback)
        }
      }),
      id: 1
    }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/repo' })
    destroyedCallbacks[0]()

    let shutdownResolved = false
    const shutdownPromise = closeAllWatchers().then(() => {
      shutdownResolved = true
    })
    await Promise.resolve()

    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
    expect(shutdownResolved).toBe(false)

    resolveUnsubscribe()
    await shutdownPromise
    expect(shutdownResolved).toBe(true)
  })

  it('awaits an unsubscribe already started by watcher error cleanup during shutdown', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let watcherCallback: (err: Error | null, events: []) => void = () => {}
    let resolveUnsubscribe: () => void = () => {}
    const unsubscribeMock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUnsubscribe = resolve
        })
    )
    vi.mocked(subscribeParcelWatcher).mockImplementation(async (_root, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe: unsubscribeMock } as never
    })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/repo' })
    watcherCallback(new Error('root disappeared'), [])

    let shutdownResolved = false
    const shutdownPromise = closeAllWatchers().then(() => {
      shutdownResolved = true
    })
    await Promise.resolve()

    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
    expect(shutdownResolved).toBe(false)

    resolveUnsubscribe()
    await shutdownPromise
    expect(shutdownResolved).toBe(true)
  })

  it('unsubscribes if the sender is destroyed while the local watcher is opening', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const destroyedCallbacks: (() => void)[] = []
    let resolveSubscribe: (subscription: { unsubscribe: () => void }) => void = () => {}
    const unsubscribeMock = vi.fn()
    vi.mocked(subscribeParcelWatcher).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve as typeof resolveSubscribe
        })
    )
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'destroyed') {
          destroyedCallbacks.push(callback)
        }
      }),
      id: 1
    }

    const watchPromise = handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/tmp/repo' }
    ) as Promise<unknown>
    await vi.waitFor(() => {
      expect(subscribeParcelWatcher).toHaveBeenCalled()
    })
    expect(destroyedCallbacks).toHaveLength(1)
    destroyedCallbacks[0]()
    resolveSubscribe({ unsubscribe: unsubscribeMock })
    await watchPromise

    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
    expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })

  it('dedupes concurrent local watcher opens for the same root', async () => {
    const statResolvers: (() => void)[] = []
    vi.mocked(stat).mockImplementation(
      () =>
        new Promise((resolve) => {
          statResolvers.push(() => resolve({ isDirectory: () => true } as never))
        })
    )
    const subscribeResolvers: ((subscription: { unsubscribe: () => void }) => void)[] = []
    const unsubscribeMock = vi.fn()
    vi.mocked(subscribeParcelWatcher).mockImplementation(
      () =>
        new Promise((resolve) => {
          subscribeResolvers.push(resolve as (subscription: { unsubscribe: () => void }) => void)
        })
    )
    const senderOne = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      id: 1
    }
    const senderTwo = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      id: 2
    }

    const watchOne = handlers['fs:watchWorktree'](
      { sender: senderOne },
      { worktreePath: '/tmp/repo' }
    ) as Promise<unknown>
    await vi.waitFor(() => {
      expect(statResolvers).toHaveLength(1)
    })
    const watchTwo = handlers['fs:watchWorktree'](
      { sender: senderTwo },
      { worktreePath: '/tmp/repo' }
    ) as Promise<unknown>

    try {
      await Promise.resolve()
      for (const resolveStat of statResolvers) {
        resolveStat()
      }
      await vi.waitFor(() => {
        expect(subscribeParcelWatcher).toHaveBeenCalled()
      })
      await Promise.resolve()

      expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1)
    } finally {
      for (const resolveSubscribe of subscribeResolvers) {
        resolveSubscribe({ unsubscribe: unsubscribeMock })
      }
      await Promise.allSettled([watchOne, watchTwo])
    }

    expect(senderOne.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
    expect(senderTwo.once).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })
})
