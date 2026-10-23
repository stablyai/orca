import { createWatcherSender } from './filesystem-watcher-test-sender'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))

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

import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { stat } from 'node:fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'
import { createWslWatcher } from './filesystem-watcher-wsl'
import { resetWatcherChildRegistryForTest } from './parcel-watcher-child-registry'
import { acquireWatcherRemovalGate } from './watcher-removal-gate'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>

describe('registerFilesystemWatcherHandlers', () => {
  const handlers: HandlerMap = {}
  const originalPlatform = process.platform

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
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
      { sender: createWatcherSender(1) },
      { worktreePath: 'C:\\repo' }
    )

    expect(subscribeParcelWatcher).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
      expect.objectContaining({ backend: 'windows' })
    )

    await closeAllWatchers()
  })

  it('rejects installs during destructive removal and allows a retry afterward', async () => {
    vi.mocked(stat).mockResolvedValue({ isDirectory: () => true } as never)
    vi.mocked(subscribeParcelWatcher).mockResolvedValue({ unsubscribe: vi.fn() } as never)
    const sender = createWatcherSender(1)
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

  it('never watches an SSH path on the local disk', async () => {
    const sender = createWatcherSender(1)
    const args = { worktreePath: '/home/me/repo', connectionId: 'conn-1' }

    await expect(handlers['fs:watchWorktree']({ sender }, args)).resolves.toBeUndefined()
    handlers['fs:unwatchWorktree']({ sender }, args)

    expect(stat).not.toHaveBeenCalled()
    expect(subscribeParcelWatcher).not.toHaveBeenCalled()
  })
})
