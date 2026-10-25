import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDebouncedBatch } from './filesystem-watcher-batch-control'

type WatchArgs = { worktreePath: string; connectionId?: string }
class Sender extends EventEmitter {
  constructor(readonly id: number) {
    super()
  }
  isDestroyed = () => false
  send = vi.fn()
}
const { handleMock, createLocal } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  createLocal: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:fs/promises', () => ({ stat: async () => ({ isDirectory: () => true }) }))
vi.mock('./filesystem-watcher-local-events', () => ({
  createLocalWatcher: createLocal,
  scheduleLocalBatchFlush: vi.fn()
}))
vi.mock('./filesystem/watcher-process/parcel-watcher-process', () => ({
  disposeWatcherProcess: vi.fn()
}))
import { watcherLifecycleState as state } from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import { registerFilesystemWatcherHandlers } from './filesystem-watcher-handlers'
import { closeAllWatchers } from './filesystem-watcher-shutdown'
import {
  closeLocalWatcherForWorktreePath,
  restoreLocalWatcherAfterFailedRemoval
} from './filesystem-watcher-local-removal'

const handlers = new Map<string, (event: { sender: Sender }, args: WatchArgs) => Promise<void>>()
function invoke(channel: string, sender: Sender, args: WatchArgs): Promise<void> {
  const handler = handlers.get(channel)
  if (!handler) {
    throw new Error(`Missing ${channel}`)
  }
  return handler({ sender }, args)
}
const watch = (sender: Sender, args: WatchArgs) => invoke('fs:watchWorktree', sender, args)
const unwatch = (sender: Sender, args: WatchArgs) => invoke('fs:unwatchWorktree', sender, args)
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function localRoot(unsubscribe = vi.fn(async () => {})) {
  return {
    subscription: { unsubscribe },
    listeners: new Map(),
    batch: createDebouncedBatch(),
    rootPath: '/folder'
  }
}

beforeEach(async () => {
  await closeAllWatchers()
  vi.clearAllMocks()
  createLocal.mockImplementation(async () => localRoot())
  handleMock.mockImplementation((channel, handler) => handlers.set(channel, handler))
  registerFilesystemWatcherHandlers()
})
afterEach(async () => {
  await closeAllWatchers()
  vi.useRealTimers()
})

describe('filesystem watcher renderer document ownership', () => {
  it.each(['did-navigate', 'render-process-gone'])(
    'releases installed local roots on %s without closing sibling owners',
    async (event) => {
      const sender = new Sender(1)
      const sibling = new Sender(2)
      const local = { worktreePath: '/folder' }
      const root = localRoot()
      createLocal.mockResolvedValue(root)
      await watch(sender, local)
      await watch(sibling, local)
      sender.emit(event)
      await Promise.resolve()
      expect(root.subscription.unsubscribe).not.toHaveBeenCalled()
      expect([...root.listeners.keys()]).toEqual([2])
      sibling.emit(event)
      await Promise.resolve()
      expect(root.subscription.unsubscribe).toHaveBeenCalledTimes(1)
      expect(state.watchedRoots.size).toBe(0)
      expect(sender.eventNames()).toEqual([])
      expect(sibling.eventNames()).toEqual([])
    }
  )

  it('keeps same-document and blocked navigations alive, and removes lifecycle listeners at shutdown', async () => {
    const sender = new Sender(1)
    for (let cycle = 0; cycle < 3; cycle++) {
      await watch(sender, { worktreePath: '/folder' })
      sender.emit('did-start-navigation')
      sender.emit('did-navigate-in-page')
      expect(state.watchedRoots.size).toBe(1)
      for (const event of ['destroyed', 'did-navigate', 'render-process-gone']) {
        expect(sender.listenerCount(event)).toBe(1)
      }
      await closeAllWatchers()
      expect(sender.eventNames()).toEqual([])
    }
  })

  it('does not revive a cancelled setup for a joiner whose document reloaded', async () => {
    const sender = new Sender(1)
    const joiner = new Sender(2)
    const args = { worktreePath: '/folder' }
    const install = deferred<ReturnType<typeof localRoot>>()
    createLocal.mockReturnValueOnce(install.promise)
    const first = watch(sender, args)
    await vi.waitFor(() => expect(createLocal).toHaveBeenCalledTimes(1))
    await unwatch(sender, args)
    await Promise.resolve()
    const key = getLocalWatcherRoot('/folder').key
    expect(state.inFlightLocalInstalls.get(key)?.abortController.signal.aborted).toBe(true)
    const pendingJoiner = watch(joiner, args)
    joiner.emit('did-navigate')
    const fresh = watch(joiner, { ...args, worktreePath: '/fresh' })
    const closeLate = vi.fn(async () => {})
    install.resolve(localRoot(closeLate))
    await Promise.all([first, pendingJoiner, fresh])
    expect(createLocal.mock.calls.filter(([path]) => path === '/folder')).toHaveLength(1)
    expect(closeLate).toHaveBeenCalledTimes(1)
    expect(state.watchedRoots.has(key)).toBe(false)
    expect(createLocal).toHaveBeenCalledTimes(2)
  })

  it('aborts pending setup on renderer crash and discards late success', async () => {
    const sender = new Sender(1)
    const install = deferred<ReturnType<typeof localRoot>>()
    createLocal.mockReturnValueOnce(install.promise)
    const pending = watch(sender, { worktreePath: '/folder' })
    await vi.waitFor(() => expect(createLocal).toHaveBeenCalledTimes(1))
    const token = [...state.inFlightLocalInstalls.values()][0]
    sender.emit('render-process-gone')
    await Promise.resolve()
    expect(token.abortController.signal.aborted).toBe(true)
    const closeLate = vi.fn(async () => {})
    install.resolve(localRoot(closeLate))
    await pending
    expect(closeLate).toHaveBeenCalledTimes(1)
    expect(state.watchedRoots.size).toBe(0)
  })

  it('does not restore a replaced sibling document after an awaited removal recovery', async () => {
    const first = new Sender(1)
    const sibling = new Sender(2)
    const args = { worktreePath: '/folder' }
    await watch(first, args)
    await watch(sibling, args)
    await closeLocalWatcherForWorktreePath('/folder')
    const install = deferred<ReturnType<typeof localRoot>>()
    createLocal.mockReturnValueOnce(install.promise)
    const restore = restoreLocalWatcherAfterFailedRemoval('/folder')
    await vi.waitFor(() => expect(createLocal).toHaveBeenCalledTimes(2))
    sibling.emit('did-navigate')
    install.resolve(localRoot())
    await restore
    expect(sibling.send).not.toHaveBeenCalled()
    expect(first.send).toHaveBeenCalledTimes(1)
    expect([...state.watchedRoots.values()][0].listeners.size).toBe(1)
  })

  it('retains zero roots and listeners across 15 reloads and a renderer crash', async () => {
    const sender = new Sender(1)
    const closeLocal = vi.fn(async () => {})
    createLocal.mockImplementation(async () => localRoot(closeLocal))
    for (let generation = 0; generation < 16; generation++) {
      await watch(sender, { worktreePath: `/folder-${generation}` })
      sender.emit(generation === 15 ? 'render-process-gone' : 'did-navigate')
      await Promise.resolve()
      expect(state.watchedRoots.size).toBe(0)
      expect(sender.eventNames()).toEqual([])
    }
    expect(closeLocal).toHaveBeenCalledTimes(16)
  })
})
