import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { stat } from 'node:fs/promises'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

describe('filesystem watcher unwatchable root cache', () => {
  const handlers: HandlerMap = {}

  beforeEach(async () => {
    handleMock.mockReset()
    vi.mocked(stat).mockReset()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  it('evicts oldest failed local roots while suppressing recent retries', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sender = { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1 }
    vi.mocked(stat).mockRejectedValue(new Error('missing'))

    for (let i = 0; i < 257; i += 1) {
      await handlers['fs:watchWorktree']({ sender }, { worktreePath: `/tmp/missing-${i}` })
    }
    expect(stat).toHaveBeenCalledTimes(257)

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/missing-0' })
    expect(stat).toHaveBeenCalledTimes(258)

    await handlers['fs:watchWorktree']({ sender }, { worktreePath: '/tmp/missing-256' })
    expect(stat).toHaveBeenCalledTimes(258)

    warnSpy.mockRestore()
    await closeAllWatchers()
  })
})
