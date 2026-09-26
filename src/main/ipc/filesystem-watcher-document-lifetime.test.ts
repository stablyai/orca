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
const { handleMock, watchRemote, createLocal, getProvider } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  watchRemote: vi.fn(),
  createLocal: vi.fn(),
  getProvider: vi.fn()
}))
vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:fs/promises', () => ({ stat: async () => ({ isDirectory: () => true }) }))
vi.mock('./filesystem-watcher-local-events', () => ({
  createLocalWatcher: createLocal,
  scheduleLocalBatchFlush: vi.fn()
}))
vi.mock('./parcel-watcher-process', () => ({ disposeWatcherProcess: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: getProvider,
  onSshFilesystemProviderRegistered: () => () => {}
}))
import {
  REMOTE_WATCH_RETRY_MS,
  watcherLifecycleState as state
} from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot, getRemoteWatcherKey } from './filesystem-watcher-paths'
import { reinstallRemoteWatchersForConnection } from './filesystem-watcher-remote-controller'
import { reinstallRemoteWatchersForConnectionCore } from './filesystem-watcher-remote-provider-rearm'
import {
  registerFilesystemWatcherHandlers,
  closeAllWatchers,
  closeLocalWatcherForWorktreePath,
  closeRemoteWatcherForWorktreePath,
  restoreLocalWatcherAfterFailedRemoval,
  restoreRemoteWatcherAfterFailedRemoval
} from './filesystem-watcher'

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
  watchRemote.mockImplementation(async () => vi.fn())
  getProvider.mockReturnValue({ watch: watchRemote })
  handleMock.mockImplementation((channel, handler) => handlers.set(channel, handler))
  registerFilesystemWatcherHandlers()
})
afterEach(async () => {
  await closeAllWatchers()
  vi.useRealTimers()
})

describe('filesystem watcher renderer document ownership', () => {
  it.each(['did-navigate', 'render-process-gone'])(
    'releases installed local and SSH roots on %s without closing sibling owners',
    async (event) => {
      const sender = new Sender(1)
      const sibling = new Sender(2)
      const local = { worktreePath: '/folder' }
      const remote = { ...local, connectionId: 'ssh' }
      const root = localRoot()
      const remoteClose = vi.fn()
      createLocal.mockResolvedValue(root)
      watchRemote.mockResolvedValue(remoteClose)
      await watch(sender, local)
      await watch(sender, remote)
      await watch(sibling, local)
      await watch(sibling, remote)
      sender.emit(event)
      await Promise.resolve()
      expect(root.subscription.unsubscribe).not.toHaveBeenCalled()
      expect(remoteClose).not.toHaveBeenCalled()
      expect([...root.listeners.keys()]).toEqual([2])
      expect([...state.desiredRemoteWatchers.values()][0].listeners.size).toBe(1)
      sibling.emit(event)
      await Promise.resolve()
      expect(root.subscription.unsubscribe).toHaveBeenCalledTimes(1)
      expect(remoteClose).toHaveBeenCalledTimes(1)
      expect(state.watchedRoots.size).toBe(0)
      expect(state.remoteWatchers.size).toBe(0)
      expect(state.desiredRemoteWatchers.size).toBe(0)
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

  it.each(['local', 'ssh'])(
    'does not revive a cancelled %s setup for a joiner whose document reloaded',
    async (kind) => {
      const sender = new Sender(1)
      const joiner = new Sender(2)
      const args = { worktreePath: '/folder', ...(kind === 'ssh' ? { connectionId: 'ssh' } : {}) }
      const install = deferred<ReturnType<typeof localRoot> & (() => void)>()
      const setup = kind === 'ssh' ? watchRemote : createLocal
      setup.mockReturnValueOnce(install.promise)
      const first = watch(sender, args)
      await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1))
      await unwatch(sender, args)
      await Promise.resolve()
      const key =
        kind === 'ssh' ? getRemoteWatcherKey('ssh', '/folder') : getLocalWatcherRoot('/folder').key
      const token =
        kind === 'ssh'
          ? state.inFlightRemoteInstalls.get(key)
          : state.inFlightLocalInstalls.get(key)
      expect(token?.abortController.signal.aborted).toBe(true)
      const pendingJoiner = watch(joiner, args)
      joiner.emit('did-navigate')
      const fresh = watch(joiner, { ...args, worktreePath: '/fresh' })
      const closeLate = vi.fn(async () => {})
      install.resolve(Object.assign(closeLate, localRoot(closeLate)))
      await Promise.all([first, pendingJoiner, fresh])
      expect(setup.mock.calls.filter(([path]) => path === '/folder')).toHaveLength(1)
      expect(closeLate).toHaveBeenCalledTimes(1)
      expect(kind === 'ssh' ? state.remoteWatchers.has(key) : state.watchedRoots.has(key)).toBe(
        false
      )
      expect(setup).toHaveBeenCalledTimes(2)
    }
  )

  it.each(['local', 'ssh'])(
    'aborts pending %s setup on renderer crash and discards late success',
    async (kind) => {
      const sender = new Sender(1)
      const setup = kind === 'ssh' ? watchRemote : createLocal
      const install = deferred<ReturnType<typeof localRoot> & (() => void)>()
      setup.mockReturnValueOnce(install.promise)
      const pending = watch(sender, {
        worktreePath: '/folder',
        ...(kind === 'ssh' ? { connectionId: 'ssh' } : {})
      })
      await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(1))
      const token = [
        ...(kind === 'ssh' ? state.inFlightRemoteInstalls : state.inFlightLocalInstalls).values()
      ][0]
      sender.emit('render-process-gone')
      await Promise.resolve()
      expect(token.abortController.signal.aborted).toBe(true)
      const closeLate = vi.fn(async () => {})
      install.resolve(Object.assign(closeLate, localRoot(closeLate)))
      await pending
      expect(closeLate).toHaveBeenCalledTimes(1)
      expect(state.watchedRoots.size + state.remoteWatchers.size).toBe(0)
    }
  )

  it('does not re-arm stale SSH handler or retry snapshots after reload', async () => {
    vi.useFakeTimers()
    const sender = new Sender(1)
    const args = { worktreePath: '/folder', connectionId: 'ssh' }
    watchRemote.mockRejectedValueOnce(new Error('temporary unavailable'))
    await watch(sender, args)
    const retry = deferred<() => void>()
    watchRemote.mockReturnValueOnce(retry.promise)
    await vi.advanceTimersByTimeAsync(REMOTE_WATCH_RETRY_MS)
    expect(watchRemote).toHaveBeenCalledTimes(2)
    sender.emit('did-navigate')
    // A fresh document can ask for the same root while the old retry is settling.
    const fresh = watch(sender, args)
    retry.resolve(vi.fn())
    await fresh
    expect(state.pendingRemoteWatcherRetries.size).toBe(0)
    expect(state.remoteWatcherResyncStates.size).toBe(0)
    expect(watchRemote).toHaveBeenCalledTimes(2)
  })

  it('does not re-arm an old provider snapshot into the same WebContents after replacement', async () => {
    const sender = new Sender(1)
    const args = { worktreePath: '/folder', connectionId: 'ssh' }
    await watch(sender, args)
    const pending = deferred<'unavailable'>()
    const dependencies = {
      install: vi.fn(() => pending.promise),
      requestResync: vi.fn(),
      scheduleRetry: vi.fn(),
      scheduleDormant: vi.fn()
    }
    reinstallRemoteWatchersForConnectionCore('ssh', dependencies)
    sender.emit('did-navigate')
    await watch(sender, args)
    pending.resolve('unavailable')
    await pending.promise
    await Promise.resolve()
    expect(dependencies.scheduleRetry).not.toHaveBeenCalled()
    expect(dependencies.requestResync).not.toHaveBeenCalled()
    expect(dependencies.scheduleDormant).not.toHaveBeenCalled()
  })

  it.each(['local', 'ssh'])(
    'does not restore a replaced sibling document after an awaited %s removal recovery',
    async (kind) => {
      const first = new Sender(1)
      const sibling = new Sender(2)
      const args = { worktreePath: '/folder', ...(kind === 'ssh' ? { connectionId: 'ssh' } : {}) }
      await watch(first, args)
      await watch(sibling, args)
      await (kind === 'ssh'
        ? closeRemoteWatcherForWorktreePath('ssh', '/folder')
        : closeLocalWatcherForWorktreePath('/folder'))
      const install = deferred<ReturnType<typeof localRoot> & (() => void)>()
      const setup = kind === 'ssh' ? watchRemote : createLocal
      setup.mockReturnValueOnce(install.promise)
      const restore =
        kind === 'ssh'
          ? restoreRemoteWatcherAfterFailedRemoval('ssh', '/folder')
          : restoreLocalWatcherAfterFailedRemoval('/folder')
      await vi.waitFor(() => expect(setup).toHaveBeenCalledTimes(2))
      sibling.emit('did-navigate')
      install.resolve(Object.assign(vi.fn(), localRoot()))
      await restore
      expect(sibling.send).not.toHaveBeenCalled()
      expect(first.send).toHaveBeenCalledTimes(1)
      const roots = kind === 'ssh' ? state.remoteWatchers : state.watchedRoots
      expect([...roots.values()][0].listeners.size).toBe(1)
    }
  )

  it('retains zero roots and listeners across 15 reloads and a renderer crash', async () => {
    const sender = new Sender(1)
    const closeLocal = vi.fn(async () => {})
    const closeRemote = vi.fn()
    createLocal.mockImplementation(async () => localRoot(closeLocal))
    watchRemote.mockResolvedValue(closeRemote)
    for (let generation = 0; generation < 16; generation++) {
      await watch(sender, { worktreePath: `/folder-${generation}` })
      await watch(sender, { worktreePath: `/folder-${generation}`, connectionId: 'ssh' })
      sender.emit(generation === 15 ? 'render-process-gone' : 'did-navigate')
      await Promise.resolve()
      expect(
        state.watchedRoots.size + state.remoteWatchers.size + state.desiredRemoteWatchers.size
      ).toBe(0)
      expect(sender.eventNames()).toEqual([])
    }
    expect(closeLocal).toHaveBeenCalledTimes(16)
    expect(closeRemote).toHaveBeenCalledTimes(16)
  })

  it('clears desired SSH roots while no provider is available and does not re-arm them on reconnect', async () => {
    const sender = new Sender(1)
    getProvider.mockReturnValue(undefined)
    await watch(sender, { worktreePath: '/folder', connectionId: 'ssh' })
    expect(state.pendingRemoteWatcherRetries.size).toBe(1)
    sender.emit('render-process-gone')
    getProvider.mockReturnValue({ watch: watchRemote })
    reinstallRemoteWatchersForConnection('ssh')
    expect(state.pendingRemoteWatcherRetries.size).toBe(0)
    expect(state.desiredRemoteWatchers.size).toBe(0)
    expect(watchRemote).not.toHaveBeenCalled()
  })
})
