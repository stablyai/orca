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

import {
  subscribeLocalWatcher,
  unsubscribeLocalWatcher
} from './filesystem-watcher-local-subscription'
import {
  closeLocalWatcherForWorktreePath,
  restoreLocalWatcherAfterFailedRemoval
} from './filesystem-watcher-local-removal'
import { watcherLifecycleState } from './filesystem-watcher-lifecycle-state'
import { getLocalWatcherRoot } from './filesystem-watcher-paths'
import { closeAllWatchers } from './filesystem-watcher-shutdown'
import { createWatcherSender, fireWatcherSenderEvent } from './filesystem-watcher-test-sender'

describe('watcher stat lifecycle across reuse and failed removal', () => {
  const worktreePath = resolve('stat-lifecycle')
  const { key } = getLocalWatcherRoot(worktreePath)
  let callback: (error: Error | null, events: WatcherEvent[]) => void
  const pendingStat = () => Promise.withResolvers<{ isDirectory: () => boolean }>()
  let firstStat: ReturnType<typeof pendingStat>

  function emit(name: string): void {
    callback(null, [{ type: 'update', path: join(worktreePath, name) }])
  }

  beforeEach(() => {
    vi.useFakeTimers()
    watcherLifecycleState.localWatchersClosed = false
    firstStat = pendingStat()
    statMock.mockReset().mockResolvedValue({ isDirectory: () => true })
    subscribeMock.mockReset().mockImplementation(async (_path, nextCallback) => {
      callback = nextCallback
      return { unsubscribe: vi.fn(async () => {}) }
    })
  })

  afterEach(async () => {
    await closeAllWatchers()
    firstStat.resolve({ isDirectory: () => false })
    await vi.advanceTimersByTimeAsync(0)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('drains an expired queued flush after unwatch clears a newer timer and rewatch reuses the root', async () => {
    const send = vi.fn<(channel: string, payload: FsChangedPayload) => void>()
    const sender = createWatcherSender(1, send)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: watcher lifetimes and delivery use only id, isDestroyed, on, removeListener and send from the sender double.
    await subscribeLocalWatcher(worktreePath, sender as never)
    const root = watcherLifecycleState.watchedRoots.get(key)!
    statMock.mockReturnValueOnce(firstStat.promise)
    emit('first.ts')
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
    expect(root.batch.flushInFlight).toBe(true)

    emit('queued.ts')
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
    expect(root.batch.flushQueued).toBe(true)
    emit('tail.ts')
    expect(root.batch.timer).not.toBeNull()
    unsubscribeLocalWatcher(worktreePath, sender.id)
    expect(root.batch.timer).toBeNull()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: rewatch uses the same sender double's lifetime and delivery methods.
    await subscribeLocalWatcher(worktreePath, sender as never)
    expect(watcherLifecycleState.watchedRoots.get(key)).toBe(root)

    firstStat.resolve({ isDirectory: () => false })
    await vi.advanceTimersByTimeAsync(0)
    expect(sender.send).toHaveBeenCalledTimes(2)
    const payloads = send.mock.calls.map(([, payload]) => payload)
    expect(payloads.map(({ events }) => events.map(({ absolutePath }) => absolutePath))).toEqual([
      [join(worktreePath, 'first.ts')],
      [join(worktreePath, 'queued.ts'), join(worktreePath, 'tail.ts')]
    ])
    expect(root.batch.flushInFlight).toBe(false)
    expect(root.batch.statAbortController.signal.aborted).toBe(false)
  })

  it('keeps a replacement root live when an earlier independent unsubscribe rejects during close', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const oldUnsubscribe = Promise.withResolvers<void>()
    const first = createWatcherSender(1)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: watcher lifetimes and delivery use only id, isDestroyed, on, removeListener and send from the sender double.
    await subscribeLocalWatcher(worktreePath, first as never)
    watcherLifecycleState.watchedRoots.get(key)!.subscription.unsubscribe = () =>
      oldUnsubscribe.promise
    fireWatcherSenderEvent(first, 'destroyed')
    await vi.advanceTimersByTimeAsync(0)
    expect(watcherLifecycleState.pendingLocalUnsubscribesByRoot.get(key)?.size).toBe(1)

    const replacement = createWatcherSender(2)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the replacement sender supplies the same lifetime and delivery methods as the original.
    await subscribeLocalWatcher(worktreePath, replacement as never)
    const root = watcherLifecycleState.watchedRoots.get(key)!
    const close = closeLocalWatcherForWorktreePath(worktreePath)
    const rejectedClose = expect(close).rejects.toThrow('old unsubscribe failed')
    await vi.advanceTimersByTimeAsync(0)
    oldUnsubscribe.reject(new Error('old unsubscribe failed'))
    await rejectedClose
    await restoreLocalWatcherAfterFailedRemoval(worktreePath)
    expect(watcherLifecycleState.watchedRoots.get(key)).toBe(root)
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(root.batch.cancelled).toBe(false)
    expect(root.batch.statAbortController.signal.aborted).toBe(false)

    emit('after-restore.ts')
    await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
    expect(replacement.send).toHaveBeenCalledTimes(2)
    expect(replacement.send.mock.calls[1][1]).toMatchObject({
      events: [{ kind: 'update', absolutePath: join(worktreePath, 'after-restore.ts') }]
    })
  })
})
