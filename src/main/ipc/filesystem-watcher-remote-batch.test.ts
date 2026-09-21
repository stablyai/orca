import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangeEvent } from '../../shared/filesystem-entry-types'

const { handleMock, getSshFilesystemProviderMock, providerRegistrationListeners } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    getSshFilesystemProviderMock: vi.fn(),
    providerRegistrationListeners: new Set<(connectionId: string) => void>()
  })
)

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('fs/promises', () => ({ stat: vi.fn() }))
vi.mock('@parcel/watcher', () => ({ subscribe: vi.fn() }))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getSshFilesystemProviderMock,
  onSshFilesystemProviderRegistered: (listener: (connectionId: string) => void) => {
    providerRegistrationListeners.add(listener)
    return () => providerRegistrationListeners.delete(listener)
  }
}))

import { closeAllWatchers, registerFilesystemWatcherHandlers } from './filesystem-watcher'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>
type WatchCallback = (events: FsChangeEvent[]) => void

const WORKTREE_PATH = '/home/me/repo'
const WATCH_ARGS = { worktreePath: WORKTREE_PATH, connectionId: 'conn-1' }

describe('remote filesystem watcher batching', () => {
  const handlers: HandlerMap = {}
  const watchCallbacks: WatchCallback[] = []

  function makeSender(overrides: Partial<{ isDestroyed: () => boolean }> = {}) {
    return { isDestroyed: () => false, send: vi.fn(), once: vi.fn(), id: 1, ...overrides }
  }

  beforeEach(async () => {
    vi.useRealTimers()
    handleMock.mockReset()
    getSshFilesystemProviderMock.mockReset()
    watchCallbacks.length = 0
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
    getSshFilesystemProviderMock.mockReturnValue({
      watch: vi.fn(async (_root: string, callback: WatchCallback) => {
        watchCallbacks.push(callback)
        return vi.fn()
      })
    })
  })

  it('coalesces a burst of remote events into a single fs:changed send', async () => {
    vi.useFakeTimers()
    const sender = makeSender()
    await handlers['fs:watchWorktree']({ sender }, WATCH_ARGS)

    for (let i = 0; i < 50; i++) {
      watchCallbacks[0]([{ kind: 'update', absolutePath: `${WORKTREE_PATH}/a.ts` }])
    }
    expect(sender.send).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(150)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: WORKTREE_PATH,
      events: [{ kind: 'update', absolutePath: `${WORKTREE_PATH}/a.ts` }]
    })
    await closeAllWatchers()
    vi.useRealTimers()
  })

  // An atomic replace (delete+create) followed by an rm inside one window must still tombstone the path.
  it('sends the net delete when a remote replace is removed in the same window', async () => {
    vi.useFakeTimers()
    const sender = makeSender()
    await handlers['fs:watchWorktree']({ sender }, WATCH_ARGS)

    watchCallbacks[0]([
      { kind: 'delete', absolutePath: `${WORKTREE_PATH}/dist/app.js` },
      { kind: 'create', absolutePath: `${WORKTREE_PATH}/dist/app.js` }
    ])
    watchCallbacks[0]([{ kind: 'delete', absolutePath: `${WORKTREE_PATH}/dist/app.js` }])
    await vi.advanceTimersByTimeAsync(150)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: WORKTREE_PATH,
      events: [{ kind: 'delete', absolutePath: `${WORKTREE_PATH}/dist/app.js` }]
    })
    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('collapses an oversized remote burst into one overflow payload', async () => {
    vi.useFakeTimers()
    const sender = makeSender()
    await handlers['fs:watchWorktree']({ sender }, WATCH_ARGS)

    watchCallbacks[0](
      Array.from({ length: 6_000 }, (_unused, index): FsChangeEvent => ({
        kind: 'update',
        absolutePath: `${WORKTREE_PATH}/file-${index}.ts`
      }))
    )
    await vi.advanceTimersByTimeAsync(150)

    expect(sender.send).toHaveBeenCalledTimes(1)
    expect(sender.send).toHaveBeenCalledWith('fs:changed', {
      worktreePath: WORKTREE_PATH,
      events: [{ kind: 'overflow', absolutePath: WORKTREE_PATH }]
    })
    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('sends nothing when the worktree is unwatched before the flush deadline', async () => {
    vi.useFakeTimers()
    const sender = makeSender()
    await handlers['fs:watchWorktree']({ sender }, WATCH_ARGS)

    watchCallbacks[0]([{ kind: 'update', absolutePath: `${WORKTREE_PATH}/a.ts` }])
    await handlers['fs:unwatchWorktree']({ sender }, WATCH_ARGS)
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sender.send).not.toHaveBeenCalled()
    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('sends nothing when all watchers close before the flush deadline', async () => {
    vi.useFakeTimers()
    const sender = makeSender()
    await handlers['fs:watchWorktree']({ sender }, WATCH_ARGS)

    watchCallbacks[0]([{ kind: 'update', absolutePath: `${WORKTREE_PATH}/a.ts` }])
    await closeAllWatchers()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sender.send).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('skips a WebContents destroyed while the batch was buffering', async () => {
    vi.useFakeTimers()
    let destroyed = false
    const sender = makeSender({ isDestroyed: () => destroyed })
    await handlers['fs:watchWorktree']({ sender }, WATCH_ARGS)

    watchCallbacks[0]([{ kind: 'update', absolutePath: `${WORKTREE_PATH}/a.ts` }])
    destroyed = true
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sender.send).not.toHaveBeenCalled()
    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('drops a stale flush once a newer install owns the key', async () => {
    vi.useFakeTimers()
    const sender = makeSender()
    await handlers['fs:watchWorktree']({ sender }, WATCH_ARGS)

    for (const listener of providerRegistrationListeners) {
      listener('conn-1')
    }
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchCallbacks).toHaveLength(2)
    sender.send.mockClear()

    // The replaced transport's callback still holds its own batch; its flush must not reach the renderer.
    watchCallbacks[0]([{ kind: 'update', absolutePath: `${WORKTREE_PATH}/a.ts` }])
    await vi.advanceTimersByTimeAsync(1_000)

    expect(sender.send).not.toHaveBeenCalled()
    await closeAllWatchers()
    vi.useRealTimers()
  })
})
