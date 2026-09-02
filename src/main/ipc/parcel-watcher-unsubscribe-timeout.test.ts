import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WATCHER_PROCESS_EXIT_DEADLINE_MS } from './parcel-watcher-child-termination'
import { WATCHER_PROCESS_UNSUBSCRIBE_TIMEOUT_MS } from './parcel-watcher-host-subscriptions'
import {
  acknowledgeWatcherSubscribe as ackSubscribe,
  currentWatcherChild,
  FakeWatcherChild,
  trackPromiseSettlement
} from './parcel-watcher-process-test-child'

const { existsSyncMock, forkMock, mkdtempSyncMock, rmSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  forkMock: vi.fn(),
  mkdtempSyncMock: vi.fn(() => '/tmp/orca-watcher-unsubscribe-timeout-test'),
  rmSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdtempSync: mkdtempSyncMock,
  rmSync: rmSyncMock
}))

import {
  disposeWatcherProcess,
  resetWatcherProcessForTest,
  subscribeViaWatcherProcess
} from './parcel-watcher-process'

const currentChild = (): FakeWatcherChild => currentWatcherChild(forkMock)

describe('watcher native unsubscribe timeout', () => {
  beforeEach(() => {
    resetWatcherProcessForTest()
    vi.stubEnv('VITEST', '')
    existsSyncMock.mockReturnValue(true)
    forkMock.mockImplementation(() => new FakeWatcherChild())
  })

  afterEach(() => {
    disposeWatcherProcess()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('restarts the shard and restores a healthy sibling', async () => {
    vi.useFakeTimers()
    try {
      const firstPromise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
      const first = currentChild()
      ackSubscribe(first, 0)
      const firstSubscription = await firstPromise
      const siblingInterruption = vi.fn()
      const siblingPromise = subscribeViaWatcherProcess(
        '/sibling',
        vi.fn(),
        {},
        { onInterruption: siblingInterruption }
      )
      ackSubscribe(first)
      await siblingPromise

      const unsubscribe = firstSubscription.unsubscribe()
      const isSettled = trackPromiseSettlement(unsubscribe)
      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_UNSUBSCRIBE_TIMEOUT_MS)

      expect(first.kill).toHaveBeenCalledTimes(1)
      expect(isSettled()).toBe(false)
      first.emit('exit', 0, null)
      await expect(unsubscribe).resolves.toBeUndefined()

      const replacement = currentChild()
      expect(replacement).not.toBe(first)
      expect(replacement.sent.filter((message) => message.op === 'subscribe')).toEqual([
        expect.objectContaining({ dir: '/sibling' })
      ])
      ackSubscribe(replacement)
      expect(siblingInterruption).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('spawns a fresh child after the idle kill misses the exit deadline', async () => {
    vi.useFakeTimers()
    try {
      const promise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
      const first = currentChild()
      ackSubscribe(first, 0)
      const subscription = await promise

      const unsubscribe = subscription.unsubscribe().catch((error: unknown) => error)
      expect(first.kill).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_EXIT_DEADLINE_MS)
      expect(first.kill).toHaveBeenLastCalledWith('SIGKILL')
      // Why: removal callers still fail closed on the unproven exit.
      const error = (await unsubscribe) as Error & { physicalExit?: Promise<void> }
      expect(error).toMatchObject({
        message: 'file watcher process did not exit after termination deadline',
        physicalExit: expect.any(Promise)
      })

      // Why: the idle child owned zero records, so its zombie must not poison
      // the shared supervisor — the next subscribe gets a fresh child.
      const respawnPromise = subscribeViaWatcherProcess('/repo2', vi.fn(), {})
      expect(forkMock).toHaveBeenCalledTimes(2)
      const second = currentChild()
      expect(second).not.toBe(first)
      expect(second.sent[0]).toMatchObject({ op: 'subscribe', dir: '/repo2' })
      ackSubscribe(second)
      await expect(respawnPromise).resolves.toMatchObject({ unsubscribe: expect.any(Function) })

      first.emit('exit', null, 'SIGKILL')
      await error.physicalExit
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('spawns a fresh child for a subscribe queued before an idle exit deadline miss', async () => {
    vi.useFakeTimers()
    try {
      const promise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
      const first = currentChild()
      ackSubscribe(first, 0)
      const subscription = await promise

      const unsubscribe = subscription.unsubscribe().catch((error: unknown) => error)
      const queued = subscribeViaWatcherProcess('/repo2', vi.fn(), {})

      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_EXIT_DEADLINE_MS)
      const error = (await unsubscribe) as Error & { physicalExit?: Promise<void> }
      expect(error).toMatchObject({
        message: 'file watcher process did not exit after termination deadline',
        physicalExit: expect.any(Promise)
      })

      expect(forkMock).toHaveBeenCalledTimes(2)
      const second = currentChild()
      expect(second.sent[0]).toMatchObject({ op: 'subscribe', dir: '/repo2' })
      ackSubscribe(second)
      await expect(queued).resolves.toMatchObject({ unsubscribe: expect.any(Function) })

      first.emit('exit', null, 'SIGKILL')
      await error.physicalExit
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects only after an unkillable child reaches its exit deadline', async () => {
    vi.useFakeTimers()
    try {
      const firstPromise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
      const child = currentChild()
      ackSubscribe(child, 0)
      const firstSubscription = await firstPromise
      const siblingPromise = subscribeViaWatcherProcess('/sibling', vi.fn(), {})
      ackSubscribe(child)
      await siblingPromise

      const result = firstSubscription.unsubscribe().catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_UNSUBSCRIBE_TIMEOUT_MS)
      const isSettled = trackPromiseSettlement(result)
      expect(isSettled()).toBe(false)

      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_EXIT_DEADLINE_MS)
      const error = (await result) as Error & { physicalExit?: Promise<void> }
      expect(error).toMatchObject({
        message: 'file watcher process did not exit after termination deadline',
        physicalExit: expect.any(Promise)
      })
      expect(vi.getTimerCount()).toBe(0)

      child.emit('exit', 0, null)
      await error.physicalExit
    } finally {
      vi.useRealTimers()
    }
  })
})
