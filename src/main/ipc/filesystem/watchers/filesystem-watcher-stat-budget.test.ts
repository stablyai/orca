import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join, resolve } from 'node:path'
import type { Event as WatcherEvent } from '@parcel/watcher'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import { WATCH_BATCH_INTERVAL_MS } from '../../../../shared/filesystem-watch-batch-window'

const { statMock, subscribeMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  subscribeMock: vi.fn()
}))
vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('../watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock,
  disposeWatcherProcess: vi.fn()
}))

import { createLocalWatcher } from './filesystem-watcher-local-events'
import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'
import { closeLocalWatcherForWorktreePath } from './filesystem-watcher-local-removal'
import {
  subscribeLocalWatcher,
  unsubscribeLocalWatcher
} from './filesystem-watcher-local-subscription'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { createWatcherSender } from './filesystem-watcher-test-sender'
import type { WatchedRoot } from './filesystem-watcher-wsl'

type StatResult = { isDirectory: () => boolean }
type PendingStat = { resolve: (result: StatResult) => void; reject: (error: Error) => void }

describe('main-process watcher event stat budget', () => {
  const callbacks = new Map<string, (error: Error | null, events: WatcherEvent[]) => void>()
  const pending: PendingStat[] = []
  const roots: WatchedRoot[] = []
  let active: number
  let peak: number

  async function watch(name: string) {
    const rootPath = resolve(name)
    const { key } = getLocalWatcherRoot(rootPath)
    const root = await createLocalWatcher(key, rootPath)
    const send = vi.fn<(channel: string, payload: FsChangedPayload) => void>()
    const sender = createWatcherSender(roots.length + 1, send)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: batch delivery only calls isDestroyed and send on this sender double.
    root.listeners.set(sender.id, sender as never)
    watcherLifecycleState.watchedRoots.set(key, root)
    roots.push(root)
    return { root, sender, send }
  }

  function emit(root: WatchedRoot, count: number, type: WatcherEvent['type'] = 'update') {
    const events = Array.from({ length: count }, (_, index) => ({
      type,
      path: join(root.rootPath, `file-${index}.ts`)
    }))
    callbacks.get(root.rootPath)!(null, events)
    return events
  }

  async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    watcherLifecycleState.localWatchersClosed = false
    callbacks.clear()
    pending.length = 0
    roots.length = 0
    active = 0
    peak = 0
    subscribeMock.mockReset().mockImplementation(async (path, callback) => {
      callbacks.set(path, callback)
      return { unsubscribe: vi.fn(async () => {}) }
    })
    statMock.mockReset().mockImplementation(() => {
      active++
      peak = Math.max(peak, active)
      return new Promise<StatResult>((resolveStat, reject) => {
        pending.push({ resolve: resolveStat, reject })
      }).finally(() => active--)
    })
  })

  afterEach(async () => {
    for (const root of roots) {
      cancelLocalBatchFlush(root)
    }
    for (const stat of pending.splice(0)) {
      stat.resolve({ isDirectory: () => false })
    }
    await settle()
    await closeAllWatchers()
    vi.useRealTimers()
  })

  it('caps stats across roots, releases failed slots, and preserves payload order', async () => {
    const first = await watch('budget-first')
    const second = await watch('budget-second')
    const firstEvents = emit(first.root, 16)
    const secondEvents = emit(second.root, 8)
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
    expect(statMock).toHaveBeenCalledTimes(8)
    expect(active).toBe(8)

    const firstWave = pending.splice(0)
    firstWave[0].reject(new Error('path vanished'))
    for (const stat of firstWave.slice(1)) {
      stat.resolve({ isDirectory: () => true })
    }
    await settle()
    expect(statMock).toHaveBeenCalledTimes(16)
    expect(active).toBe(8)
    expect(first.sender.send).not.toHaveBeenCalled()

    for (const stat of pending.splice(0)) {
      stat.resolve({ isDirectory: () => true })
    }
    await settle()
    expect(statMock).toHaveBeenCalledTimes(24)
    for (const stat of pending.splice(0)) {
      stat.resolve({ isDirectory: () => true })
    }
    await settle()

    expect(peak).toBe(8)
    expect(active).toBe(0)
    for (const [watcher, events] of [
      [first, firstEvents],
      [second, secondEvents]
    ] as const) {
      expect(watcher.sender.send).toHaveBeenCalledTimes(1)
      const payload = watcher.send.mock.calls[0][1]
      expect(payload.events).toEqual(
        events.map((event, index) => ({
          kind: event.type,
          absolutePath: event.path,
          isDirectory: watcher === first && index === 0 ? undefined : true
        }))
      )
    }
  })

  it('closes a waiting root without starting its stats when another root releases slots', async () => {
    const busy = await watch('budget-busy')
    const closing = await watch('budget-closing')
    const live = await watch('budget-live')
    const deleted = await watch('budget-deleted')
    emit(busy.root, 8)
    emit(closing.root, 16)
    emit(live.root, 1)
    emit(deleted.root, 1, 'delete')
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
    expect(statMock).toHaveBeenCalledTimes(8)
    expect(deleted.sender.send).toHaveBeenCalledTimes(1)

    await closeLocalWatcherForWorktreePath(closing.root.rootPath)
    await settle()
    // Waiter cancellation settles before the saturated root frees any slot.
    expect(closing.root.batch.flushInFlight).toBe(false)
    expect(closing.root.subscription.unsubscribe).toHaveBeenCalledTimes(1)
    expect(active).toBe(8)
    for (const stat of pending.splice(0)) {
      stat.resolve({ isDirectory: () => false })
    }
    await settle()
    expect(statMock).toHaveBeenCalledTimes(9)
    expect(statMock.mock.calls[8][0]).toBe(join(live.root.rootPath, 'file-0.ts'))
    pending.shift()!.resolve({ isDirectory: () => false })
    await settle()
    expect(live.sender.send).toHaveBeenCalledTimes(1)
    expect(closing.sender.send).not.toHaveBeenCalled()
    expect(peak).toBe(8)
  })

  it('rechecks cancellation after a slot grant and returns the slot to a live root', async () => {
    const busy = await watch('grant-busy')
    const closing = await watch('grant-closing')
    const live = await watch('grant-live')
    emit(busy.root, 8)
    emit(closing.root, 1)
    emit(live.root, 1)
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
    expect(statMock).toHaveBeenCalledTimes(8)

    pending.shift()!.resolve({
      isDirectory: () => {
        // Runs after release grants the slot, before the granted waiter's continuation.
        queueMicrotask(() => cancelLocalBatchFlush(closing.root))
        return false
      }
    })
    await settle()
    expect(closing.root.batch.flushInFlight).toBe(false)
    expect(closing.sender.send).not.toHaveBeenCalled()
    expect(statMock).toHaveBeenCalledTimes(9)
    expect(statMock.mock.calls[8][0]).toBe(join(live.root.rootPath, 'file-0.ts'))
    for (const stat of pending.splice(0)) {
      stat.resolve({ isDirectory: () => false })
    }
    await settle()
    expect(live.sender.send).toHaveBeenCalledTimes(1)
    expect(active).toBe(0)
  })

  it.each(['waiting', 'granted'] as const)(
    'skips stats for an unwatched root with a %s slot and preserves grace-window reuse',
    async (slotState) => {
      const busy = await watch('unwatch-busy')
      const unwatched = await watch('unwatch-idle')
      const live = await watch('unwatch-live')
      emit(busy.root, 8)
      emit(unwatched.root, 1)
      emit(live.root, 1)
      await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
      expect(statMock).toHaveBeenCalledTimes(8)

      const unwatch = () => unsubscribeLocalWatcher(unwatched.root.rootPath, unwatched.sender.id)
      if (slotState === 'waiting') {
        unwatch()
      }
      pending.shift()!.resolve({
        isDirectory: () => {
          if (slotState === 'granted') {
            queueMicrotask(unwatch)
          }
          return false
        }
      })
      await settle()
      expect(statMock).toHaveBeenCalledTimes(9)
      expect(statMock.mock.calls[8][0]).toBe(join(live.root.rootPath, 'file-0.ts'))
      expect(unwatched.root.batch.flushInFlight).toBe(false)
      expect(unwatched.sender.send).not.toHaveBeenCalled()
      for (const stat of pending.splice(0)) {
        stat.resolve({ isDirectory: () => false })
      }
      await settle()
      expect(live.sender.send).toHaveBeenCalledOnce()

      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rewatch uses the sender double's lifetime and delivery methods.
      await subscribeLocalWatcher(unwatched.root.rootPath, unwatched.sender as never)
      const { key } = getLocalWatcherRoot(unwatched.root.rootPath)
      expect(watcherLifecycleState.watchedRoots.get(key)).toBe(unwatched.root)
      expect(unwatched.root.listeners.size).toBe(1)
      expect(subscribeMock).toHaveBeenCalledTimes(3)
      expect(unwatched.root.batch.statAbortController.signal.aborted).toBe(false)
      emit(unwatched.root, 1)
      await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
      expect(statMock).toHaveBeenCalledTimes(10)
      pending.shift()!.resolve({ isDirectory: () => true })
      await settle()
      expect(unwatched.send.mock.calls).toEqual([
        [
          'fs:changed',
          {
            worktreePath: unwatched.root.rootPath,
            events: [
              {
                kind: 'update',
                absolutePath: join(unwatched.root.rootPath, 'file-0.ts'),
                isDirectory: true
              }
            ]
          }
        ]
      ])
      expect(peak).toBe(8)
      expect(active).toBe(0)
    }
  )
})
