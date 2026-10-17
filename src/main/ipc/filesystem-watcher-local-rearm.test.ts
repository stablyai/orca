import { EventEmitter } from 'node:events'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WATCH_BATCH_TRAILING_MS } from '../../shared/filesystem-watch-batch-window'

const { handleMock, statMock, subscribeViaWatcherProcessMock, disposeWatcherProcessMock } =
  vi.hoisted(() => ({
    handleMock: vi.fn(),
    statMock: vi.fn(),
    subscribeViaWatcherProcessMock: vi.fn(),
    disposeWatcherProcessMock: vi.fn()
  }))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('./parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeViaWatcherProcessMock,
  disposeWatcherProcess: disposeWatcherProcessMock
}))
vi.mock('./filesystem-watcher-wsl', () => ({ createWslWatcher: vi.fn() }))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn(),
  onSshFilesystemProviderRegistered: () => () => {}
}))

import {
  closeAllWatchers,
  closeLocalWatcherForWorktreePath,
  registerFilesystemWatcherHandlers
} from './filesystem-watcher'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { WATCHER_ROOT_DELETED_MESSAGE } from './parcel-watcher-process-protocol'
import { resetWatcherChildRegistryForTest } from './parcel-watcher-child-registry'

type HandlerMap = Record<string, (_event: unknown, args: unknown) => unknown>
type WatcherCallback = (error: Error | null, events: WatcherEvent[]) => void

class Sender extends EventEmitter {
  destroyed = false
  send = vi.fn()
  constructor(readonly id: number) {
    super()
  }
  isDestroyed = (): boolean => this.destroyed
}

const ROOT = '/tmp/local-rearm-root'
const args = { worktreePath: ROOT }
const overflow = {
  worktreePath: ROOT,
  events: [{ kind: 'overflow', absolutePath: ROOT }]
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await Promise.resolve()
  }
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

describe('local filesystem watcher re-arm after a watcher error', () => {
  const handlers: HandlerMap = {}
  let callbacks: WatcherCallback[]

  const watch = (sender: Sender): unknown => handlers['fs:watchWorktree']({ sender }, args)
  const lastCallback = (): WatcherCallback => {
    const callback = callbacks.at(-1)
    if (!callback) {
      throw new Error('expected a watcher subscription')
    }
    return callback
  }
  const expectNoPendingRearm = (): void => {
    expect(watcherLifecycleState.pendingLocalCapacityRetries.size).toBe(0)
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    handleMock.mockReset()
    statMock.mockReset()
    subscribeViaWatcherProcessMock.mockReset()
    disposeWatcherProcessMock.mockReset()
    resetWatcherChildRegistryForTest()
    for (const key of Object.keys(handlers)) {
      delete handlers[key]
    }
    handleMock.mockImplementation((channel, handler) => {
      handlers[channel] = handler
    })
    statMock.mockResolvedValue({ isDirectory: () => true })
    callbacks = []
    subscribeViaWatcherProcessMock.mockImplementation(
      async (_root: string, callback: WatcherCallback) => {
        callbacks.push(callback)
        return { unsubscribe: vi.fn().mockResolvedValue(undefined) }
      }
    )
    registerFilesystemWatcherHandlers()
    await closeAllWatchers()
  })

  afterEach(async () => {
    await closeAllWatchers()
    resetWatcherChildRegistryForTest()
    vi.useRealTimers()
  })

  it('sends an overflow, re-subscribes after 1s, resyncs, and delivers later events', async () => {
    const sender = new Sender(1)
    await watch(sender)
    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledOnce()

    lastCallback()(new Error('watcher broke'), [])
    expect(sender.send).toHaveBeenCalledOnce()
    expect(sender.send).toHaveBeenLastCalledWith('fs:changed', overflow)

    await advance(999)
    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledOnce()
    await advance(1)
    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenLastCalledWith('fs:changed', overflow)
    expectNoPendingRearm()

    lastCallback()(null, [{ type: 'create', path: `${ROOT}/file.ts` }])
    await advance(WATCH_BATCH_TRAILING_MS)
    expect(sender.send).toHaveBeenCalledTimes(3)
    expect(sender.send).toHaveBeenLastCalledWith('fs:changed', {
      worktreePath: ROOT,
      events: [expect.objectContaining({ absolutePath: `${ROOT}/file.ts` })]
    })
  })

  it('doubles the re-subscribe delay on repeated errors and holds it at the cap', async () => {
    await watch(new Sender(1))
    let subscribes = 1
    for (const delayMs of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]) {
      // Errors shortly after each re-arm still count as the same incident.
      await advance(100)
      lastCallback()(new Error('watcher broke'), [])
      await advance(delayMs - 1)
      expect(subscribeViaWatcherProcessMock).toHaveBeenCalledTimes(subscribes)
      await advance(1)
      expect(subscribeViaWatcherProcessMock).toHaveBeenCalledTimes(++subscribes)
    }
  })

  it('restarts the backoff once a re-armed watcher stays healthy as long as its last wait', async () => {
    await watch(new Sender(1))
    let subscribes = 1
    for (const [healthyMs, delayMs] of [
      [100, 1000],
      [100, 2000],
      [100, 4000],
      [3999, 8000],
      [8000, 1000]
    ]) {
      await advance(healthyMs)
      lastCallback()(new Error('watcher broke'), [])
      await advance(delayMs - 1)
      expect(subscribeViaWatcherProcessMock).toHaveBeenCalledTimes(subscribes)
      await advance(1)
      expect(subscribeViaWatcherProcessMock).toHaveBeenCalledTimes(++subscribes)
    }
  })

  it('never re-subscribes when the watched root was deleted', async () => {
    const sender = new Sender(1)
    await watch(sender)
    lastCallback()(new Error(WATCHER_ROOT_DELETED_MESSAGE), [])
    expect(sender.send).toHaveBeenCalledWith('fs:changed', overflow)

    await advance(60_000)
    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledOnce()
    expectNoPendingRearm()
  })

  it.each([
    ['stat rejects', () => statMock.mockRejectedValueOnce(new Error('ENOENT')), 1],
    [
      'subscribe rejects',
      () => subscribeViaWatcherProcessMock.mockRejectedValueOnce(new Error('EPERM')),
      2
    ]
  ])('stops after a failed re-arm when %s', async (_name, failNextInstall, subscribes) => {
    const sender = new Sender(1)
    await watch(sender)
    lastCallback()(new Error('watcher broke'), [])
    failNextInstall()

    await advance(1000)
    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledTimes(subscribes)
    await advance(60_000)
    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledTimes(subscribes)
    expect(sender.send).toHaveBeenCalledOnce()
    expectNoPendingRearm()
  })

  describe('cancels a pending re-arm', () => {
    let sender: Sender

    beforeEach(async () => {
      sender = new Sender(1)
      await watch(sender)
      lastCallback()(new Error('watcher broke'), [])
      expect(watcherLifecycleState.pendingLocalCapacityRetries.size).toBe(1)
    })

    async function expectNoResubscribe(): Promise<void> {
      await advance(60_000)
      expect(subscribeViaWatcherProcessMock).toHaveBeenCalledOnce()
      expectNoPendingRearm()
    }

    it('when the renderer unwatches', async () => {
      handlers['fs:unwatchWorktree']({ sender }, args)
      await expectNoResubscribe()
    })

    it('when the renderer is destroyed', async () => {
      sender.destroyed = true
      sender.emit('destroyed')
      await expectNoResubscribe()
    })

    it('when all watchers close', async () => {
      await closeAllWatchers()
      await expectNoResubscribe()
      expect(watcherLifecycleState.localWatcherRearmBackoff.size).toBe(0)
    })

    it('when the worktree watcher is closed for removal', async () => {
      await closeLocalWatcherForWorktreePath(ROOT)
      await expectNoResubscribe()
      expect(watcherLifecycleState.localWatcherRearmBackoff.size).toBe(0)
    })
  })

  it('re-subscribes once for two renderers and resyncs both', async () => {
    const first = new Sender(1)
    const second = new Sender(2)
    await watch(first)
    await watch(second)
    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledOnce()

    lastCallback()(new Error('watcher broke'), [])
    await advance(1000)
    expect(subscribeViaWatcherProcessMock).toHaveBeenCalledTimes(2)
    for (const sender of [first, second]) {
      expect(sender.send).toHaveBeenCalledTimes(2)
      expect(sender.send).toHaveBeenLastCalledWith('fs:changed', overflow)
    }

    lastCallback()(null, [{ type: 'update', path: `${ROOT}/file.ts` }])
    await advance(WATCH_BATCH_TRAILING_MS)
    for (const sender of [first, second]) {
      expect(sender.send).toHaveBeenCalledTimes(3)
      expect(sender.send).toHaveBeenLastCalledWith('fs:changed', {
        worktreePath: ROOT,
        events: [expect.objectContaining({ absolutePath: `${ROOT}/file.ts` })]
      })
    }
  })
})
