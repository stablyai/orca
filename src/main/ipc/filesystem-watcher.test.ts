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

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'
import { stat } from 'fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

describe('registerFilesystemWatcherHandlers', () => {
  const handlers: HandlerMap = {}
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useRealTimers()
    handleMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    vi.mocked(stat).mockReset()
    vi.mocked(subscribeParcelWatcher).mockReset()
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

    expect(watchMock).toHaveBeenCalledWith('/home/me/repo', expect.any(Function))
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
})
