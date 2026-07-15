import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

describe('remote filesystem watcher cancellation', () => {
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

  it('aborts pending SSH setup after the last same-root listener leaves and cleans late success', async () => {
    let installSignal: AbortSignal | undefined
    let resolveInstall: ((unwatch: () => void) => void) | undefined
    const lateUnwatch = vi.fn()
    const watchMock = vi.fn(
      (_rootPath, _callback, options?: { signal?: AbortSignal }) =>
        new Promise<() => void>((resolve) => {
          installSignal = options?.signal
          resolveInstall = resolve
        })
    )
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    const senderOne = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const first = handlers['fs:watchWorktree']({ sender: senderOne }, args) as Promise<unknown>
    const second = handlers['fs:watchWorktree']({ sender: senderTwo }, args) as Promise<unknown>

    await Promise.resolve()
    try {
      expect(watchMock).toHaveBeenCalledTimes(1)
      expect(installSignal?.aborted).toBe(false)

      handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, args)
      await Promise.resolve()
      expect(installSignal?.aborted).toBe(false)

      handlers['fs:unwatchWorktree']({ sender: { id: 2 } }, args)
      await Promise.resolve()
      expect(installSignal?.aborted).toBe(true)
    } finally {
      resolveInstall?.(lateUnwatch)
      await Promise.all([first, second])
    }
    expect(lateUnwatch).toHaveBeenCalledTimes(1)
  })

  it('starts a fresh same-root generation when a listener arrives after physical abort', async () => {
    let firstSignal: AbortSignal | undefined
    let secondCallback: ((events: unknown[]) => void) | undefined
    const secondUnwatch = vi.fn()
    const watchMock = vi
      .fn()
      .mockImplementationOnce(
        (_rootPath, _callback, options?: { signal?: AbortSignal }) =>
          new Promise<() => void>((_resolve, reject) => {
            firstSignal = options?.signal
            options?.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('cancelled')
                error.name = 'AbortError'
                reject(error)
              },
              { once: true }
            )
          })
      )
      .mockImplementationOnce((_rootPath, callback) => {
        secondCallback = callback
        return Promise.resolve(secondUnwatch)
      })
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    const firstSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const secondSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const first = handlers['fs:watchWorktree']({ sender: firstSender }, args) as Promise<unknown>

    await Promise.resolve()
    handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, args)
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true))
    const second = handlers['fs:watchWorktree']({ sender: secondSender }, args) as Promise<unknown>

    await Promise.all([first, second])
    expect(watchMock).toHaveBeenCalledTimes(2)
    secondCallback?.([{ kind: 'update', absolutePath: '/home/me/repo/file.ts' }])
    expect(secondSender.send).toHaveBeenCalledTimes(1)

    handlers['fs:unwatchWorktree']({ sender: { id: 2 } }, args)
    expect(secondUnwatch).toHaveBeenCalledTimes(1)
  })

  it('aborts pending SSH setup on sender destruction and watcher shutdown', async () => {
    const installs = new Map<
      string,
      { signal: AbortSignal | undefined; resolve: (unwatch: () => void) => void }
    >()
    const watchMock = vi.fn(
      (rootPath: string, _callback, options?: { signal?: AbortSignal }) =>
        new Promise<() => void>((resolve) => {
          installs.set(rootPath, { signal: options?.signal, resolve })
        })
    )
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    const destroyedCallbacks: (() => void)[] = []
    const destroyedSender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'destroyed') {
          destroyedCallbacks.push(callback)
        }
      }),
      id: 1
    }
    const destroyedArgs = { worktreePath: '/destroyed', connectionId: 'conn-1' }
    const destroyedWatch = handlers['fs:watchWorktree'](
      { sender: destroyedSender },
      destroyedArgs
    ) as Promise<unknown>

    await Promise.resolve()
    destroyedCallbacks[0]()
    await Promise.resolve()
    expect(installs.get('/destroyed')?.signal?.aborted).toBe(true)
    installs.get('/destroyed')?.resolve(vi.fn())
    await destroyedWatch

    const shutdownSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const shutdownArgs = { worktreePath: '/shutdown', connectionId: 'conn-1' }
    const shutdownWatch = handlers['fs:watchWorktree'](
      { sender: shutdownSender },
      shutdownArgs
    ) as Promise<unknown>

    await Promise.resolve()
    await closeAllWatchers()
    expect(installs.get('/shutdown')?.signal?.aborted).toBe(true)
    installs.get('/shutdown')?.resolve(vi.fn())
    await shutdownWatch
  })

  it('keeps the shared install alive when a replacement sender joins before the deferred abort fires', async () => {
    let installSignal: AbortSignal | undefined
    let resolveInstall: ((unwatch: () => void) => void) | undefined
    const watchMock = vi.fn(
      (_rootPath, _callback, options?: { signal?: AbortSignal }) =>
        new Promise<() => void>((resolve) => {
          installSignal = options?.signal
          resolveInstall = resolve
        })
    )
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    const senderOne = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const first = handlers['fs:watchWorktree']({ sender: senderOne }, args) as Promise<unknown>

    await Promise.resolve()
    expect(watchMock).toHaveBeenCalledTimes(1)

    // The last listener leaves and a replacement joins in the SAME tick — before
    // the queued abort microtask runs. The shared install must survive.
    handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, args)
    const second = handlers['fs:watchWorktree']({ sender: senderTwo }, args) as Promise<unknown>

    await Promise.resolve()
    await Promise.resolve()
    expect(installSignal?.aborted).toBe(false)
    expect(watchMock).toHaveBeenCalledTimes(1)

    resolveInstall?.(vi.fn())
    await Promise.all([first, second])
  })

  it('refuses a post-shutdown joiner recursion instead of resurrecting the install', async () => {
    let firstSignal: AbortSignal | undefined
    let resolveFirst: ((unwatch: () => void) => void) | undefined
    const lateUnwatch = vi.fn()
    const watchMock = vi.fn(
      (_rootPath, _callback, options?: { signal?: AbortSignal }) =>
        new Promise<() => void>((resolve) => {
          firstSignal = options?.signal
          resolveFirst = resolve
        })
    )
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    const firstSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const secondSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const first = handlers['fs:watchWorktree']({ sender: firstSender }, args) as Promise<unknown>

    await Promise.resolve()
    expect(watchMock).toHaveBeenCalledTimes(1)

    // Last listener leaves -> deferred abort fires while the install is still pending.
    handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, args)
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true))

    // Joiner arrives after physical abort (canJoinInstall === false); it awaits the
    // 'cancelled' resolution and would recurse into a fresh install.
    const second = handlers['fs:watchWorktree']({ sender: secondSender }, args) as Promise<unknown>
    await Promise.resolve()

    // Shutdown latches the subsystem before the joiner's recursion runs.
    await closeAllWatchers()

    // Late success of the aborted generation must be unwatched, not registered.
    resolveFirst?.(lateUnwatch)
    await Promise.all([first, second])

    // The recursion is refused post-shutdown: provider.watch() is never called again.
    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(lateUnwatch).toHaveBeenCalledTimes(1)
  })

  it('refuses a pre-shutdown joiner recursion even after a new watch reopens the subsystem', async () => {
    const installs = new Map<
      string,
      { signal: AbortSignal | undefined; resolve: (unwatch: () => void) => void }
    >()
    const watchMock = vi.fn(
      (rootPath: string, _callback, options?: { signal?: AbortSignal }) =>
        new Promise<() => void>((resolve) => {
          installs.set(rootPath, { signal: options?.signal, resolve })
        })
    )
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    const reopenArgs = { worktreePath: '/home/me/other', connectionId: 'conn-1' }
    const lateUnwatch = vi.fn()
    const firstSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const joinerSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const reopenSender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 3 }
    const first = handlers['fs:watchWorktree']({ sender: firstSender }, args) as Promise<unknown>

    await Promise.resolve()
    expect(watchMock).toHaveBeenCalledTimes(1)

    // Last listener leaves -> deferred abort fires while the install is still pending.
    handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, args)
    await vi.waitFor(() => expect(installs.get('/home/me/repo')?.signal?.aborted).toBe(true))

    // Joiner arrives after physical abort (canJoinInstall === false); it captures the
    // current lifecycle generation and awaits the 'cancelled' resolution.
    const joiner = handlers['fs:watchWorktree']({ sender: joinerSender }, args) as Promise<unknown>
    await Promise.resolve()

    // Shutdown bumps the generation, then a genuine new watch reopens the subsystem
    // (clearing the boolean latch) before the joiner resumes.
    await closeAllWatchers()
    const reopen = handlers['fs:watchWorktree'](
      { sender: reopenSender },
      reopenArgs
    ) as Promise<unknown>
    await Promise.resolve()
    expect(watchMock).toHaveBeenCalledTimes(2)

    // Now let the aborted install resolve; the joiner recurses on the stale generation.
    installs.get('/home/me/repo')?.resolve(lateUnwatch)
    installs.get('/home/me/other')?.resolve(vi.fn())
    await Promise.all([first, joiner, reopen])

    // The joiner's recursion is refused despite the reopen: no third provider.watch().
    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(watchMock.mock.calls.filter(([rootPath]) => rootPath === '/home/me/repo')).toHaveLength(
      1
    )
    expect(lateUnwatch).toHaveBeenCalledTimes(1)
  })
})
