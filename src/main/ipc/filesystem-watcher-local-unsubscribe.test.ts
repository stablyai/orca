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
import { stat } from 'fs/promises'
import { subscribe as subscribeParcelWatcher } from '@parcel/watcher'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => Promise<unknown> | unknown>

describe('local filesystem watcher shutdown', () => {
  const handlers: HandlerMap = {}

  beforeEach(() => {
    vi.useRealTimers()
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
  })

  it('awaits unsubscribe already started by sender cleanup during shutdown', async () => {
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
})
