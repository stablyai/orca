import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, getSshFilesystemProviderMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  getSshFilesystemProviderMock: vi.fn()
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
  getSshFilesystemProvider: getSshFilesystemProviderMock
}))

import {
  closeAllWatchers,
  closeRemoteWatcherForWorktreePath,
  registerFilesystemWatcherHandlers,
  restoreRemoteWatcherAfterFailedRemoval
} from './filesystem-watcher'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import { createWslWatcher } from './filesystem-watcher-wsl'
import {
  MAX_PHYSICAL_WATCHER_CHILDREN,
  reserveWatcherChild,
  resetWatcherChildRegistryForTest,
  WatcherChildCapacityError
} from './parcel-watcher-child-registry'
import { acquireWatcherRemovalGate } from './watcher-removal-gate'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

describe('registerFilesystemWatcherHandlers', () => {
  const handlers: HandlerMap = {}
  const originalPlatform = process.platform

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(subscribeParcelWatcher).mockReset()
    vi.mocked(createWslWatcher).mockReset()
    resetWatcherChildRegistryForTest()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  it('pins Parcel to the Windows backend for local Windows watches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: vi.fn() } as never)

    await handlers['fs:watchWorktree'](
      { sender: { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 } },
      { worktreePath: 'C:\\repo' }
    )

    expect(subscribeParcelWatcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ backend: 'windows' })
    )

    await closeAllWatchers()
  })

  it('automatically retries a WSL watcher when child capacity becomes available', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const heldReservations = Array.from({ length: MAX_PHYSICAL_WATCHER_CHILDREN }, () =>
      reserveWatcherChild()
    )
    vi.mocked(createWslWatcher).mockImplementation(async () => {
      const release = reserveWatcherChild()
      if (!release) {
        throw new WatcherChildCapacityError()
      }
      return {
        subscription: { unsubscribe: vi.fn(async () => release()) },
        listeners: new Map(),
        batch: { events: [], overflowed: false, timer: null, firstEventAt: 0 }
      }
    })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const args = { worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' }

    await expect(handlers['fs:watchWorktree']({ sender }, args)).resolves.toBeUndefined()
    expect(createWslWatcher).toHaveBeenCalledOnce()

    heldReservations.pop()?.()
    await vi.waitFor(() => expect(createWslWatcher).toHaveBeenCalledTimes(2))
    await closeAllWatchers()
    heldReservations.forEach((release) => release?.())
  })

  it('cancels a pending WSL capacity retry when the renderer unwatches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    const heldReservations = Array.from({ length: MAX_PHYSICAL_WATCHER_CHILDREN }, () =>
      reserveWatcherChild()
    )
    vi.mocked(createWslWatcher).mockRejectedValue(new WatcherChildCapacityError())
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const args = { worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo' }

    await handlers['fs:watchWorktree']({ sender }, args)
    handlers['fs:unwatchWorktree']({ sender: { id: sender.id } }, args)
    heldReservations.pop()?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(createWslWatcher).toHaveBeenCalledOnce()
    heldReservations.forEach((release) => release?.())
  })

  it('rejects installs during destructive removal and allows a retry afterward', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: vi.fn() } as never)
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const removal = acquireWatcherRemovalGate('/repo')
    await removal.ready

    await expect(
      handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo' })
    ).rejects.toMatchObject({ code: 'watcher_removal_in_progress' })
    expect(subscribeParcelWatcher).not.toHaveBeenCalled()

    removal.release()
    await expect(
      handlers['fs:watchWorktree']({ sender }, { worktreePath: '/repo' })
    ).resolves.toBeUndefined()
    expect(subscribeParcelWatcher).toHaveBeenCalledTimes(1)
  })

  it('quietly skips SSH worktree watches while the filesystem provider is unavailable', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getSshFilesystemProviderMock.mockReturnValue(undefined)

    await expect(
      handlers['fs:watchWorktree'](
        { sender: { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 } },
        { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
      )
    ).resolves.toBeUndefined()
    await handlers['fs:watchWorktree'](
      { sender: { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).toHaveBeenCalledWith(
      '[filesystem-watcher] SSH filesystem provider unavailable; retrying watch for /home/me/repo on connection conn-1'
    )
    handlers['fs:unwatchWorktree'](
      { sender: { id: 1 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  it('binds a pending SSH worktree watch after the filesystem provider appears', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sendMock = vi.fn()
    const sender = { isDestroyed: () => false, send: sendMock, once: vi.fn(), id: 1 }
    const unwatchMock = vi.fn()
    const watchMock = vi.fn().mockResolvedValue(unwatchMock)
    getSshFilesystemProviderMock.mockReturnValueOnce(undefined)

    await handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )

    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(watchMock).toHaveBeenCalledWith('/home/me/repo', expect.any(Function), {
      signal: expect.any(AbortSignal),
      onTerminalError: expect.any(Function)
    })
    const onEvents = watchMock.mock.calls[0][1]
    onEvents([{ path: '/home/me/repo/file.txt', type: 'update' }])
    expect(sendMock).toHaveBeenCalledWith('fs:changed', {
      worktreePath: '/home/me/repo',
      events: [{ path: '/home/me/repo/file.txt', type: 'update' }]
    })
    warnSpy.mockRestore()
    handlers['fs:unwatchWorktree'](
      { sender: { id: 1 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    vi.useRealTimers()
  })

  it('retries SSH worktree watches when provider setup rejects', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sendMock = vi.fn()
    const sender = { isDestroyed: () => false, send: sendMock, once: vi.fn(), id: 1 }
    const unwatchMock = vi.fn()
    const retryWatchMock = vi.fn().mockResolvedValue(unwatchMock)
    getSshFilesystemProviderMock
      .mockReturnValueOnce({
        watch: vi.fn().mockRejectedValue(new Error('provider disposed'))
      })
      .mockReturnValue({ watch: retryWatchMock })

    await expect(
      handlers['fs:watchWorktree'](
        { sender },
        { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
      )
    ).resolves.toBeUndefined()

    await vi.advanceTimersByTimeAsync(1_000)

    expect(retryWatchMock).toHaveBeenCalledWith('/home/me/repo', expect.any(Function), {
      signal: expect.any(AbortSignal),
      onTerminalError: expect.any(Function)
    })
    handlers['fs:unwatchWorktree'](
      { sender: { id: 1 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    expect(unwatchMock).toHaveBeenCalledTimes(1)
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  it('cancels pending SSH watch retries during watcher shutdown', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const watchMock = vi.fn()
    getSshFilesystemProviderMock.mockReturnValueOnce(undefined)

    await handlers['fs:watchWorktree'](
      { sender: { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )

    await closeAllWatchers()
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })
    await vi.advanceTimersByTimeAsync(1_000)

    expect(watchMock).not.toHaveBeenCalled()
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  it('retries all live renderer owners after a terminal relay watch failure', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const senderOne = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const watchMock = vi.fn().mockResolvedValue(vi.fn())
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    await handlers['fs:watchWorktree'](
      { sender: senderOne },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    await handlers['fs:watchWorktree'](
      { sender: senderTwo },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    const staleTerminal = watchMock.mock.calls[0][2].onTerminalError as (error: Error) => void

    staleTerminal(new Error('relay watcher recovery failed'))
    handlers['fs:unwatchWorktree'](
      { sender: senderOne },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    await vi.advanceTimersByTimeAsync(1_000)

    expect(watchMock).toHaveBeenCalledTimes(2)
    const recoveredEvents = watchMock.mock.calls[1][1] as (events: unknown[]) => void
    recoveredEvents([{ kind: 'update', absolutePath: '/home/me/repo/file.ts' }])
    expect(senderOne.send).not.toHaveBeenCalled()
    expect(senderTwo.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: '/home/me/repo',
      events: [{ kind: 'update', absolutePath: '/home/me/repo/file.ts' }]
    })

    staleTerminal(new Error('late stale failure'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchMock).toHaveBeenCalledTimes(2)
    warnSpy.mockRestore()
    vi.useRealTimers()
  })

  it('shares SSH worktree watchers across renderer senders until the last unwatch', async () => {
    const sendOne = vi.fn()
    const sendTwo = vi.fn()
    const senderOne = { isDestroyed: () => false, send: sendOne, once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: sendTwo, once: vi.fn(), id: 2 }
    const unwatchMock = vi.fn()
    const watchMock = vi.fn().mockResolvedValue(unwatchMock)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    await handlers['fs:watchWorktree'](
      { sender: senderOne },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    await handlers['fs:watchWorktree'](
      { sender: senderTwo },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )

    expect(watchMock).toHaveBeenCalledTimes(1)
    const onEvents = watchMock.mock.calls[0][1]
    onEvents([{ path: '/home/me/repo/file.txt', type: 'update' }])
    expect(sendOne).toHaveBeenCalledTimes(1)
    expect(sendTwo).toHaveBeenCalledTimes(1)

    handlers['fs:unwatchWorktree'](
      { sender: { id: 1 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    expect(unwatchMock).not.toHaveBeenCalled()

    handlers['fs:unwatchWorktree'](
      { sender: { id: 2 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    expect(unwatchMock).toHaveBeenCalledTimes(1)
  })

  it('awaits acknowledged SSH watcher teardown before remote deletion', async () => {
    let resolveClose: () => void = () => {}
    const closeWatch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve
        })
    )
    const provider = { watch: vi.fn().mockResolvedValue(vi.fn()), closeWatch }
    getSshFilesystemProviderMock.mockReturnValue(provider)
    await handlers['fs:watchWorktree'](
      { sender: { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )

    let closed = false
    const close = closeRemoteWatcherForWorktreePath('conn-1', '/home/me/repo').then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closeWatch).toHaveBeenCalledWith('/home/me/repo')
    expect(closed).toBe(false)

    resolveClose()
    await close
  })

  it('re-arms SSH listeners after remote worktree deletion fails', async () => {
    const firstUnwatch = vi.fn()
    const replacementUnwatch = vi.fn()
    const watchMock = vi
      .fn()
      .mockResolvedValueOnce(firstUnwatch)
      .mockResolvedValueOnce(replacementUnwatch)
    const closeWatch = vi.fn().mockResolvedValue(undefined)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock, closeWatch })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }

    await handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    await closeRemoteWatcherForWorktreePath('conn-1', '/home/me/repo')
    await restoreRemoteWatcherAfterFailedRemoval('conn-1', '/home/me/repo')

    expect(closeWatch).toHaveBeenCalledWith('/home/me/repo')
    expect(watchMock).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: '/home/me/repo',
      events: [{ kind: 'overflow', absolutePath: '/home/me/repo' }]
    })
    const replacementEvents = watchMock.mock.calls[1][1] as (events: unknown[]) => void
    replacementEvents([{ kind: 'update', absolutePath: '/home/me/repo/file.ts' }])
    expect(sender.send).toHaveBeenLastCalledWith('fs:changed', {
      worktreePath: '/home/me/repo',
      events: [{ kind: 'update', absolutePath: '/home/me/repo/file.ts' }]
    })
  })

  it('does not restore an SSH listener stopped while deletion is pending', async () => {
    const firstUnwatch = vi.fn()
    const watchMock = vi.fn().mockResolvedValue(firstUnwatch)
    const closeWatch = vi.fn().mockResolvedValue(undefined)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock, closeWatch })
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }

    await handlers['fs:watchWorktree']({ sender }, args)
    await closeRemoteWatcherForWorktreePath('conn-1', '/home/me/repo')
    handlers['fs:unwatchWorktree']({ sender }, args)
    await restoreRemoteWatcherAfterFailedRemoval('conn-1', '/home/me/repo')

    expect(closeWatch).toHaveBeenCalledWith('/home/me/repo')
    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('does not restore an SSH listener destroyed while deletion is pending', async () => {
    const watchMock = vi.fn().mockResolvedValue(vi.fn())
    const closeWatch = vi.fn().mockResolvedValue(undefined)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock, closeWatch })
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
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }

    await handlers['fs:watchWorktree']({ sender }, args)
    await closeRemoteWatcherForWorktreePath('conn-1', '/home/me/repo')
    destroyedCallbacks[0]?.()
    await restoreRemoteWatcherAfterFailedRemoval('conn-1', '/home/me/repo')

    expect(closeWatch).toHaveBeenCalledWith('/home/me/repo')
    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('preserves remote event routing when acknowledged teardown rejects', async () => {
    const sendOne = vi.fn()
    const sendTwo = vi.fn()
    const senderOne = { isDestroyed: () => false, send: sendOne, once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: sendTwo, once: vi.fn(), id: 2 }
    const watchMock = vi.fn().mockResolvedValue(vi.fn())
    const closeWatch = vi
      .fn()
      .mockRejectedValueOnce(new Error('Remote path is still watched by another client'))
      .mockResolvedValueOnce(undefined)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock, closeWatch })
    await handlers['fs:watchWorktree'](
      { sender: senderOne },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )

    await expect(closeRemoteWatcherForWorktreePath('conn-1', '/home/me/repo')).rejects.toThrow(
      'still watched by another client'
    )
    const onEvents = watchMock.mock.calls[0][1]
    onEvents([{ path: '/home/me/repo/file.txt', type: 'update' }])
    expect(sendOne).toHaveBeenCalledTimes(1)

    await handlers['fs:watchWorktree'](
      { sender: senderTwo },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    expect(watchMock).toHaveBeenCalledTimes(1)
    onEvents([{ path: '/home/me/repo/file-2.txt', type: 'update' }])
    expect(sendOne).toHaveBeenCalledTimes(2)
    expect(sendTwo).toHaveBeenCalledTimes(1)

    await expect(
      closeRemoteWatcherForWorktreePath('conn-1', '/home/me/repo')
    ).resolves.toBeUndefined()
    expect(closeWatch).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent pending SSH worktree watcher installs', async () => {
    const sendOne = vi.fn()
    const sendTwo = vi.fn()
    const senderOne = { isDestroyed: () => false, send: sendOne, once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: sendTwo, once: vi.fn(), id: 2 }
    const unwatchMock = vi.fn()
    let resolveWatch: (unwatch: () => void) => void = () => {}
    const watchPromise = new Promise<() => void>((resolve) => {
      resolveWatch = resolve
    })
    const watchMock = vi.fn().mockReturnValue(watchPromise)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    const firstWatch = handlers['fs:watchWorktree'](
      { sender: senderOne },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    ) as Promise<unknown>
    const secondWatch = handlers['fs:watchWorktree'](
      { sender: senderTwo },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    ) as Promise<unknown>

    await Promise.resolve()
    expect(watchMock).toHaveBeenCalledTimes(1)

    resolveWatch(unwatchMock)
    await Promise.all([firstWatch, secondWatch])

    const onEvents = watchMock.mock.calls[0][1]
    onEvents([{ path: '/home/me/repo/file.txt', type: 'update' }])
    expect(sendOne).toHaveBeenCalledTimes(1)
    expect(sendTwo).toHaveBeenCalledTimes(1)

    handlers['fs:unwatchWorktree'](
      { sender: { id: 1 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    handlers['fs:unwatchWorktree'](
      { sender: { id: 2 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    expect(unwatchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a pending SSH watcher install alive when only one pending sender unwatches', async () => {
    const sendOne = vi.fn()
    const sendTwo = vi.fn()
    const senderOne = { isDestroyed: () => false, send: sendOne, once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: sendTwo, once: vi.fn(), id: 2 }
    const unwatchMock = vi.fn()
    let resolveWatch: (unwatch: () => void) => void = () => {}
    const watchPromise = new Promise<() => void>((resolve) => {
      resolveWatch = resolve
    })
    const watchMock = vi.fn().mockReturnValue(watchPromise)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    const firstWatch = handlers['fs:watchWorktree'](
      { sender: senderOne },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    ) as Promise<unknown>
    const secondWatch = handlers['fs:watchWorktree'](
      { sender: senderTwo },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    ) as Promise<unknown>

    await Promise.resolve()
    handlers['fs:unwatchWorktree'](
      { sender: { id: 2 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    resolveWatch(unwatchMock)
    await Promise.all([firstWatch, secondWatch])

    const onEvents = watchMock.mock.calls[0][1]
    onEvents([{ path: '/home/me/repo/file.txt', type: 'update' }])
    expect(sendOne).toHaveBeenCalledTimes(1)
    expect(sendTwo).not.toHaveBeenCalled()

    handlers['fs:unwatchWorktree'](
      { sender: { id: 1 } },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    )
    expect(unwatchMock).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes if the sender is destroyed while an SSH watcher is opening', async () => {
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
    const unwatchMock = vi.fn()
    let resolveWatch: (unwatch: () => void) => void = () => {}
    const watchPromise = new Promise<() => void>((resolve) => {
      resolveWatch = resolve
    })
    const watchMock = vi.fn().mockReturnValue(watchPromise)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    const watch = handlers['fs:watchWorktree'](
      { sender },
      { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    ) as Promise<unknown>

    await Promise.resolve()
    expect(watchMock).toHaveBeenCalledTimes(1)
    expect(destroyedCallbacks).toHaveLength(1)

    destroyedCallbacks[0]()
    resolveWatch(unwatchMock)
    await watch

    expect(unwatchMock).toHaveBeenCalledTimes(1)
    const onEvents = watchMock.mock.calls[0][1]
    onEvents([{ path: '/home/me/repo/file.txt', type: 'update' }])
    expect(sender.send).not.toHaveBeenCalled()
  })

  it('revives a pending SSH watcher install when a new sender joins after cancellation', async () => {
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }
    const senderOne = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    const senderTwo = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 2 }
    const unwatchMock = vi.fn()
    let resolveWatch!: (unwatch: () => void) => void
    const watchMock = vi.fn().mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveWatch = resolve
      })
    )
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    const firstWatch = handlers['fs:watchWorktree']({ sender: senderOne }, args) as Promise<unknown>

    await Promise.resolve()
    handlers['fs:unwatchWorktree']({ sender: { id: 1 } }, args)
    const secondWatch = handlers['fs:watchWorktree'](
      { sender: senderTwo },
      args
    ) as Promise<unknown>

    expect(watchMock).toHaveBeenCalledTimes(1)
    resolveWatch(unwatchMock)
    await Promise.all([firstWatch, secondWatch])

    const onEvents = watchMock.mock.calls[0][1]
    onEvents([{ path: '/home/me/repo/file.txt', type: 'update' }])
    expect(senderOne.send).not.toHaveBeenCalled()
    expect(senderTwo.send).toHaveBeenCalledTimes(1)

    handlers['fs:unwatchWorktree']({ sender: { id: 2 } }, args)
    expect(unwatchMock).toHaveBeenCalledTimes(1)
  })

  it('registers one destroyed listener for many SSH worktree watches', async () => {
    const destroyedCallbacks: (() => void)[] = []
    const sender = {
      isDestroyed: () => false,
      send: vi.fn(),
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'destroyed') {
          destroyedCallbacks.push(callback)
        }
      }),
      id: 99
    }
    const unwatchMock = vi.fn()
    const watchMock = vi.fn().mockResolvedValue(unwatchMock)
    getSshFilesystemProviderMock.mockReturnValue({ watch: watchMock })

    for (let i = 0; i < 12; i += 1) {
      await handlers['fs:watchWorktree'](
        { sender },
        { worktreePath: `/home/me/repo-${i}`, connectionId: 'conn-1' }
      )
    }

    // Why: WebContents warns after 10 listeners. The cleanup work still covers
    // every remote watch by scanning the shared remote watcher registry.
    expect(sender.once).toHaveBeenCalledTimes(1)
    expect(destroyedCallbacks).toHaveLength(1)

    destroyedCallbacks[0]()

    expect(unwatchMock).toHaveBeenCalledTimes(12)
  })
})
