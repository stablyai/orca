import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FsChangedPayload } from '../../../../shared/filesystem-entry-types'
import { WATCH_BATCH_INTERVAL_MS } from '../../../../shared/filesystem-watch-batch-window'

const { statMock, subscribeMock, spawnMock } = vi.hoisted(() => ({
  statMock: vi.fn(),
  subscribeMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:fs/promises', () => ({ stat: statMock }))
vi.mock('../watcher-process/parcel-watcher-process', () => ({
  subscribeViaWatcherProcess: subscribeMock
}))
vi.mock('./wsl-watcher-spawn', () => ({ spawnWslWatcherProcess: spawnMock }))

import { cancelLocalBatchFlush } from './filesystem-watcher-batch-control'
import { createLocalWatcher, scheduleLocalBatchFlush } from './filesystem-watcher-local-events'
import { createWatcherSender } from './filesystem-watcher-test-sender'
import { createWslWatcher, type WatchedRoot } from './filesystem-watcher-wsl'

class SnapshotChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn(() => {
    this.emit('close', null, 'SIGTERM')
    return true
  })
}

function snapshotFrame(mtime: string): string {
  return `\0\x1e\0f\t${mtime}\t/home/me/repo/README.md\0\0\x1f\0`
}

function listen(root: WatchedRoot, id: number) {
  const send = vi.fn<(channel: string, payload: FsChangedPayload) => void>()
  const sender = createWatcherSender(id, send)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: batch delivery only calls the fake sender's isDestroyed and send methods.
  root.listeners.set(id, sender as never)
  return send
}

type StatResult = { isDirectory: () => boolean }
const roots: WatchedRoot[] = []
const pendingStats: ReturnType<typeof Promise.withResolvers<StatResult>>[] = []

beforeEach(() => {
  vi.useFakeTimers()
  statMock.mockReset().mockImplementation(() => {
    const deferred = Promise.withResolvers<StatResult>()
    pendingStats.push(deferred)
    return deferred.promise
  })
  subscribeMock.mockReset()
  spawnMock.mockReset()
})

afterEach(async () => {
  for (const root of roots.splice(0)) {
    cancelLocalBatchFlush(root)
    await root.subscription.unsubscribe()
  }
  for (const deferred of pendingStats.splice(0)) {
    deferred.resolve({ isDirectory: () => false })
  }
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
})

it('delivers overflow after a spontaneous WSL stop without starting queued metadata stats', async () => {
  let onLocalEvents: (error: Error | null, events: WatcherEvent[]) => void = () => {
    throw new Error('Local watcher has not subscribed')
  }
  subscribeMock.mockImplementation(async (_path, callback) => {
    onLocalEvents = callback
    return { unsubscribe: vi.fn(async () => {}) }
  })
  const localPath = resolve('busy-local-root')
  const local = await createLocalWatcher(localPath, localPath)
  roots.push(local)
  const localSend = listen(local, 1)

  const child = new SnapshotChild()
  spawnMock.mockReturnValueOnce(child)
  const wslPath = '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo'
  const watchedRoots = new Map<string, WatchedRoot>()
  const onUnexpectedStop = vi.fn()
  const starting = createWslWatcher(wslPath, wslPath, {
    ignoreDirs: [],
    scheduleBatchFlush: scheduleLocalBatchFlush,
    watchedRoots,
    onUnexpectedStop
  })
  child.stdout.write(snapshotFrame('1'))
  const wsl = await starting
  roots.push(wsl)
  watchedRoots.set(wslPath, wsl)
  const wslSend = listen(wsl, 2)

  onLocalEvents(
    null,
    Array.from({ length: 8 }, (_, index) => ({
      type: 'update',
      path: join(localPath, `file-${index}.ts`)
    }))
  )
  await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
  expect(statMock).toHaveBeenCalledTimes(8)

  child.stdout.write(snapshotFrame('2'))
  await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
  expect(wsl.batch.flushInFlight).toBe(true)
  expect(wsl.batch.events).toEqual([])
  expect(statMock).toHaveBeenCalledTimes(8)
  expect(wslSend).not.toHaveBeenCalled()

  child.emit('close', null, 'SIGTERM')
  expect(onUnexpectedStop).toHaveBeenCalledExactlyOnceWith(wsl, 'Ubuntu')
  expect(watchedRoots.has(wslPath)).toBe(false)
  expect(wsl.batch.statAbortController.signal.aborted).toBe(true)
  await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)
  expect(wsl.batch.flushInFlight).toBe(false)
  expect(
    wslSend.mock.calls.filter(([, payload]) =>
      payload.events.some((event) => event.kind === 'overflow')
    )
  ).toEqual([
    ['fs:changed', { worktreePath: wslPath, events: [{ kind: 'overflow', absolutePath: wslPath }] }]
  ])
  expect(statMock).toHaveBeenCalledTimes(8)

  for (const deferred of pendingStats.splice(0)) {
    deferred.resolve({ isDirectory: () => false })
  }
  await vi.advanceTimersByTimeAsync(WATCH_BATCH_INTERVAL_MS)

  expect(statMock).toHaveBeenCalledTimes(8)
  expect(localSend).toHaveBeenCalledOnce()
  const overflowCalls = wslSend.mock.calls.filter(([, payload]) =>
    payload.events.some((event) => event.kind === 'overflow')
  )
  expect(overflowCalls).toEqual([
    ['fs:changed', { worktreePath: wslPath, events: [{ kind: 'overflow', absolutePath: wslPath }] }]
  ])
  expect(wsl.batch.flushInFlight).toBe(false)
})
