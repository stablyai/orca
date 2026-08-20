import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ParcelWatcherProcess from './parcel-watcher-process'

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

vi.mock('./parcel-watcher-process', async (importOriginal) => {
  const actual = await importOriginal<typeof ParcelWatcherProcess>()
  return {
    ...actual,
    subscribeViaWatcherProcess: vi.fn(actual.subscribeViaWatcherProcess)
  }
})

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  onSshFilesystemProviderRegistered: () => () => {}
}))

import {
  closeAllWatchers,
  closeLocalWatcherForWorktreePath,
  registerFilesystemWatcherHandlers,
  restoreLocalWatcherAfterFailedRemoval
} from './filesystem-watcher'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import { subscribeViaWatcherProcess } from './parcel-watcher-process'
import { WatcherProcessFailure } from './parcel-watcher-process-failure'
import { join, resolve } from 'node:path'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

// Why resolved: '/tmp/repo' is not an absolute path on Windows, so the watcher
// resolves it onto the current volume ('C:\tmp\repo') and reports that back.
// Fixtures carry the same resolution so roots, keys and event paths line up.
const REPO_ROOT = resolve('/tmp/repo')
const OTHER_ROOT = resolve('/tmp/other')
const REPO_RETRY_FILE = join(REPO_ROOT, 'retry.txt')

describe('local filesystem watcher unsubscribe cleanup', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    handleMock.mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(subscribeParcelWatcher).mockReset()
    vi.mocked(subscribeViaWatcherProcess).mockClear()
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

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })
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

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })
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
      { worktreePath: REPO_ROOT }
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
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>
    await vi.waitFor(() => {
      expect(statResolvers).toHaveLength(1)
    })
    const watchTwo = handlers['fs:watchWorktree'](
      { sender: senderTwo },
      { worktreePath: REPO_ROOT }
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

  it('keeps a single grace teardown timer for duplicate local unwatch calls', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const unsubscribeMock = vi.fn()
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: unsubscribeMock } as never)
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      id: 1
    }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })

    vi.useFakeTimers()
    try {
      handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, { worktreePath: REPO_ROOT })
      handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, { worktreePath: REPO_ROOT })

      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(unsubscribeMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('closes a live local watcher immediately for worktree deletion', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const unsubscribeMock = vi.fn()
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: unsubscribeMock } as never)
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      id: 1
    }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })
    await closeLocalWatcherForWorktreePath(REPO_ROOT)

    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['C:\\Repo', 'c:/repo'],
    ['\\\\Server\\Share\\Repo', '//server/share/repo']
  ])('matches Windows watcher cleanup across path casing for %s', async (watchPath, closePath) => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const unsubscribeMock = vi.fn()
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: unsubscribeMock } as never)
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      id: 1
    }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: watchPath })
    await closeLocalWatcherForWorktreePath(closePath)

    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['C:\\Repo', 'c:/repo'],
    ['\\\\Server\\Share\\Repo', '//server/share/repo']
  ])('keeps the physical Windows root in event payloads for %s', async (watchPath, closePath) => {
    vi.useFakeTimers()
    try {
      vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
      let watcherCallback: (
        error: Error | null,
        events: { type: 'update'; path: string }[]
      ) => void = () => undefined
      const unsubscribeMock = vi.fn()
      vi.mocked(subscribeParcelWatcher).mockImplementation(async (_path, callback) => {
        watcherCallback = callback as typeof watcherCallback
        return { unsubscribe: unsubscribeMock } as never
      })
      const sender = {
        isDestroyed: () => false,
        send: vi.fn(),
        once: vi.fn(),
        id: 1
      }

      await handlers['fs:watchWorktree']({ sender }, { worktreePath: watchPath })
      watcherCallback(null, [{ type: 'update', path: `${watchPath}\\file.txt` }])
      await vi.advanceTimersByTimeAsync(150)

      expect(sender.send).toHaveBeenCalledWith(
        'fs:changed',
        expect.objectContaining({ worktreePath: watchPath })
      )
      await closeLocalWatcherForWorktreePath(closePath)
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates watcher termination failure to worktree deletion', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const terminationError = new Error('watcher child did not exit')
    const unsubscribeMock = vi.fn().mockRejectedValue(terminationError)
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: unsubscribeMock } as never)
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })

    await expect(closeLocalWatcherForWorktreePath(REPO_ROOT)).rejects.toBe(terminationError)
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('awaits and propagates sender cleanup already tearing down the same root', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const terminationError = new Error('watcher child did not exit')
    let rejectUnsubscribe: (error: Error) => void = () => {}
    const unsubscribeMock = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectUnsubscribe = reject
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
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })
    destroyedCallbacks[0]()
    await vi.waitFor(() => expect(unsubscribeMock).toHaveBeenCalledTimes(1))

    let settled = false
    const closeFailure = expect(
      closeLocalWatcherForWorktreePath(REPO_ROOT).finally(() => {
        settled = true
      })
    ).rejects.toBe(terminationError)
    await Promise.resolve()
    expect(settled).toBe(false)
    rejectUnsubscribe(terminationError)
    await closeFailure
  })

  it('retains teardown failure only until the unkillable child physically exits', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let signalPhysicalExit: () => void = () => {}
    const physicalExit = new Promise<void>((resolve) => {
      signalPhysicalExit = resolve
    })
    const terminationError = new WatcherProcessFailure(
      'file watcher process did not exit after termination deadline',
      'supervisor',
      'process_unavailable',
      physicalExit
    )
    const unsubscribeMock = vi.fn().mockRejectedValue(terminationError)
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
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })
    destroyedCallbacks[0]()
    await vi.waitFor(() => expect(unsubscribeMock).toHaveBeenCalledTimes(1))

    await expect(closeLocalWatcherForWorktreePath(REPO_ROOT)).rejects.toBe(terminationError)
    signalPhysicalExit()
    await Promise.resolve()
    await expect(closeLocalWatcherForWorktreePath(REPO_ROOT)).resolves.toBeUndefined()
  })

  it('retains callback terminal failure when the cleared subscription later unsubscribes cleanly', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let watcherCallback: (error: Error | null, events: []) => void = () => {}
    let signalPhysicalExit: () => void = () => {}
    const physicalExit = new Promise<void>((resolve) => {
      signalPhysicalExit = resolve
    })
    const terminationError = new WatcherProcessFailure(
      'file watcher process did not exit after termination deadline',
      'supervisor',
      'process_unavailable',
      physicalExit
    )
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    vi.mocked(subscribeViaWatcherProcess).mockImplementationOnce(async (_dir, callback) => {
      watcherCallback = callback as typeof watcherCallback
      return { unsubscribe }
    })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })

    watcherCallback(terminationError, [])
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))

    await expect(closeLocalWatcherForWorktreePath(REPO_ROOT)).rejects.toBe(terminationError)
    signalPhysicalExit()
    await physicalExit
    await expect(closeLocalWatcherForWorktreePath(REPO_ROOT)).resolves.toBeUndefined()
  })

  it('propagates terminal child failure while deletion cancels an active crawl', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let signalPhysicalExit: () => void = () => undefined
    const physicalExit = new Promise<void>((resolve) => {
      signalPhysicalExit = resolve
    })
    const terminationError = new WatcherProcessFailure(
      'file watcher process did not exit after termination deadline',
      'supervisor',
      'process_unavailable',
      physicalExit
    )
    vi.mocked(subscribeViaWatcherProcess).mockImplementationOnce(
      (_dir, _callback, _opts, hooks) =>
        new Promise((_resolve, reject) => {
          hooks?.signal?.addEventListener('abort', () => reject(terminationError), { once: true })
        })
    )
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const watchPromise = handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>
    const watchFailure = expect(watchPromise).rejects.toBe(terminationError)
    await vi.waitFor(() => expect(subscribeViaWatcherProcess).toHaveBeenCalledTimes(1))

    await expect(closeLocalWatcherForWorktreePath(REPO_ROOT)).rejects.toBe(terminationError)
    await watchFailure
    await expect(closeLocalWatcherForWorktreePath(REPO_ROOT)).rejects.toBe(terminationError)

    signalPhysicalExit()
    await physicalExit
    await expect(closeLocalWatcherForWorktreePath(REPO_ROOT)).resolves.toBeUndefined()
  })

  it('closes a pending grace-teardown watcher immediately for worktree deletion', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const unsubscribeMock = vi.fn()
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: unsubscribeMock } as never)
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      id: 1
    }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })

    vi.useFakeTimers()
    try {
      handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, { worktreePath: REPO_ROOT })

      expect(vi.getTimerCount()).toBe(1)
      await closeLocalWatcherForWorktreePath(REPO_ROOT)

      expect(unsubscribeMock).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts an opening local watcher when the last listener unwatches', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
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
      once: vi.fn(),
      id: 1
    }

    const watchPromise = handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>
    await vi.waitFor(() => {
      expect(subscribeParcelWatcher).toHaveBeenCalled()
    })

    const unwatchPromise = handlers['fs:unwatchWorktree'](
      { sender },
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>
    // Why: unwatch must abort the in-flight install so watchWorktree settles
    // without waiting for the native subscribe crawl to finish.
    const watchSettledEarly = await Promise.race([
      watchPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20))
    ])
    resolveSubscribe({ unsubscribe: unsubscribeMock })
    await Promise.all([watchPromise, unwatchPromise])

    expect(watchSettledEarly).toBe(true)
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('retries on a fresh generation when a listener arrives after install abort', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    let replacementCallback: Parameters<typeof subscribeViaWatcherProcess>[1] = () => undefined
    const replacementUnsubscribe = vi.fn()
    vi.mocked(subscribeViaWatcherProcess)
      .mockImplementationOnce(
        (_dir, _callback, _options, hooks) =>
          new Promise((_resolve, reject) => {
            hooks?.signal?.addEventListener('abort', () => reject(new Error('subscribe aborted')), {
              once: true
            })
          })
      )
      .mockImplementationOnce(async (_dir, callback) => {
        replacementCallback = callback
        return { unsubscribe: replacementUnsubscribe }
      })
    const firstSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const replacementSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }

    const firstWatch = handlers['fs:watchWorktree'](
      { sender: firstSender },
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>
    await vi.waitFor(() => expect(subscribeViaWatcherProcess).toHaveBeenCalledTimes(1))

    handlers['fs:unwatchWorktree']({ sender: firstSender }, { worktreePath: REPO_ROOT })
    const replacementWatch = handlers['fs:watchWorktree'](
      { sender: replacementSender },
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>

    await Promise.all([firstWatch, replacementWatch])
    expect(subscribeViaWatcherProcess).toHaveBeenCalledTimes(2)
    replacementCallback(null, [{ type: 'update', path: REPO_RETRY_FILE }] as never)
    await vi.waitFor(() =>
      expect(replacementSender.send).toHaveBeenCalledWith('fs:changed', {
        worktreePath: REPO_ROOT,
        events: [{ kind: 'update', absolutePath: REPO_RETRY_FILE, isDirectory: true }]
      })
    )
  })

  it('refuses an aborted pre-shutdown joiner after a different root reopens watching', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const installs = new Map<
      string,
      {
        signal: AbortSignal | undefined
        resolve: (subscription: { unsubscribe: () => void }) => void
      }
    >()
    const install = (
      rootPath: string,
      _callback: unknown,
      _options: unknown,
      hooks?: { signal?: AbortSignal }
    ) =>
      new Promise((resolve) => {
        installs.set(rootPath, { signal: hooks?.signal, resolve })
      })
    vi.mocked(subscribeViaWatcherProcess)
      .mockImplementationOnce(install as never)
      .mockImplementationOnce(install as never)
    const lateUnsubscribe = vi.fn()
    const firstSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const joinerSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const reopenSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 3 }
    const first = handlers['fs:watchWorktree'](
      { sender: firstSender },
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>

    await vi.waitFor(() => expect(subscribeViaWatcherProcess).toHaveBeenCalledTimes(1))
    handlers['fs:unwatchWorktree']({ sender: firstSender }, { worktreePath: REPO_ROOT })
    expect(installs.get(REPO_ROOT)?.signal?.aborted).toBe(true)

    const joiner = handlers['fs:watchWorktree'](
      { sender: joinerSender },
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>
    await closeAllWatchers()
    const reopen = handlers['fs:watchWorktree'](
      { sender: reopenSender },
      { worktreePath: OTHER_ROOT }
    ) as Promise<unknown>
    await vi.waitFor(() => expect(subscribeViaWatcherProcess).toHaveBeenCalledTimes(2))

    installs.get(REPO_ROOT)?.resolve({ unsubscribe: lateUnsubscribe })
    installs.get(OTHER_ROOT)?.resolve({ unsubscribe: vi.fn() })
    await Promise.all([first, joiner, reopen])

    expect(subscribeViaWatcherProcess).toHaveBeenCalledTimes(2)
    expect(
      vi
        .mocked(subscribeViaWatcherProcess)
        .mock.calls.filter(([rootPath]) => rootPath.endsWith(REPO_ROOT))
    ).toHaveLength(1)
    await vi.waitFor(() => expect(lateUnsubscribe).toHaveBeenCalledTimes(1))
  })

  it('cancels an opening local watcher for worktree deletion', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
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
      once: vi.fn(),
      id: 1
    }

    const watchPromise = handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>
    await vi.waitFor(() => {
      expect(subscribeParcelWatcher).toHaveBeenCalled()
    })
    const closePromise = closeLocalWatcherForWorktreePath(REPO_ROOT)
    const closedBeforeNativeSubscribe = await Promise.race([
      closePromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0))
    ])
    resolveSubscribe({ unsubscribe: unsubscribeMock })
    await Promise.all([watchPromise, closePromise])

    expect(closedBeforeNativeSubscribe).toBe(true)
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it('re-arms active local listeners after worktree deletion fails', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const firstUnsubscribe = vi.fn()
    const replacementUnsubscribe = vi.fn()
    vi.mocked(subscribeParcelWatcher)
      .mockResolvedValueOnce({ unsubscribe: firstUnsubscribe } as never)
      .mockResolvedValueOnce({ unsubscribe: replacementUnsubscribe } as never)
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn(),
      id: 1
    }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })
    await closeLocalWatcherForWorktreePath(REPO_ROOT)
    await restoreLocalWatcherAfterFailedRemoval(REPO_ROOT)

    expect(firstUnsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: REPO_ROOT,
      events: [{ kind: 'overflow', absolutePath: REPO_ROOT }]
    })
  })

  it('does not restore a local listener stopped while deletion is pending', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const firstUnsubscribe = vi.fn()
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: firstUnsubscribe } as never)
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })
    await closeLocalWatcherForWorktreePath(REPO_ROOT)
    handlers['fs:unwatchWorktree']({ sender }, { worktreePath: REPO_ROOT })
    await restoreLocalWatcherAfterFailedRemoval(REPO_ROOT)

    expect(firstUnsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('does not restore a local listener destroyed while deletion is pending', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const firstUnsubscribe = vi.fn()
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: firstUnsubscribe } as never)
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

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: REPO_ROOT })
    await closeLocalWatcherForWorktreePath(REPO_ROOT)
    destroyedCallbacks[0]?.()
    await restoreLocalWatcherAfterFailedRemoval(REPO_ROOT)

    expect(firstUnsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('cancels an opening local watcher during app shutdown', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
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
      once: vi.fn(),
      id: 1
    }

    const watchPromise = handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: REPO_ROOT }
    ) as Promise<unknown>
    await vi.waitFor(() => {
      expect(subscribeParcelWatcher).toHaveBeenCalled()
    })
    const shutdownPromise = closeAllWatchers()
    const closedBeforeNativeSubscribe = await Promise.race([
      shutdownPromise.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 0))
    ])
    resolveSubscribe({ unsubscribe: unsubscribeMock })
    await Promise.all([watchPromise, shutdownPromise])

    expect(closedBeforeNativeSubscribe).toBe(true)
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })
})
