import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WATCHER_PROCESS_CANCEL_TIMEOUT_MS } from './parcel-watcher-cancellation-tracker'
import { WATCHER_PROCESS_EXIT_DEADLINE_MS } from './parcel-watcher-child-termination'

const { existsSyncMock, forkMock, mkdtempSyncMock, rmSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn(),
  forkMock: vi.fn(),
  mkdtempSyncMock: vi.fn(() => '/tmp/orca-watcher-disconnect-test'),
  rmSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdtempSync: mkdtempSyncMock,
  rmSync: rmSyncMock
}))

import {
  createWatcherProcessSupervisor,
  disposeWatcherProcess,
  resetWatcherProcessForTest,
  subscribeViaWatcherProcess
} from './parcel-watcher-process'
import type { WatcherProcessSubscription } from './parcel-watcher-process-subscription'

type SentMessage = { op: string; id: number }

class FakeChild extends EventEmitter {
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  sent: SentMessage[] = []
  stderr = new EventEmitter()
  kill = vi.fn(() => {
    this.connected = false
  })
  send = vi.fn((message: SentMessage) => {
    this.sent.push(message)
    return true
  })
}

function currentChild(): FakeChild {
  return forkMock.mock.results.at(-1)?.value as FakeChild
}

function ackSubscribe(child: FakeChild): void {
  const message = child.sent.findLast((candidate) => candidate.op === 'subscribe')
  child.emit('message', { op: 'subscribed', id: message?.id })
}

async function subscribePair(): Promise<{ child: FakeChild; unsubscribe: () => Promise<void> }> {
  const firstPromise = subscribeViaWatcherProcess('/first', vi.fn(), {})
  const child = currentChild()
  ackSubscribe(child)
  const first = await firstPromise
  const siblingPromise = subscribeViaWatcherProcess('/sibling', vi.fn(), {})
  ackSubscribe(child)
  await siblingPromise
  return { child, unsubscribe: first.unsubscribe }
}

describe('watcher disconnect termination', () => {
  beforeEach(() => {
    resetWatcherProcessForTest()
    vi.stubEnv('VITEST', '')
    existsSyncMock.mockReturnValue(true)
    forkMock.mockImplementation(() => new FakeChild())
  })

  afterEach(() => {
    disposeWatcherProcess()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('keeps unsubscribe pending until physical exit', async () => {
    const { child, unsubscribe } = await subscribePair()
    let settled = false
    const pending = unsubscribe().then(() => {
      settled = true
    })
    child.connected = false
    child.emit('disconnect')
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(forkMock).toHaveBeenCalledTimes(1)
    child.emit('exit', 0, null)
    await pending
    expect(settled).toBe(true)
  })

  it('forces disconnected ready-subscription teardown even with a live sibling', async () => {
    const { child, unsubscribe } = await subscribePair()
    child.connected = false
    let settled = false
    const pending = unsubscribe().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    child.emit('exit', 0, null)
    await pending
    expect(forkMock).toHaveBeenCalledTimes(2)
  })

  it('forces disconnected pending-crawl teardown even with a live sibling', async () => {
    const siblingPromise = subscribeViaWatcherProcess('/sibling', vi.fn(), {})
    const child = currentChild()
    ackSubscribe(child)
    await siblingPromise
    const controller = new AbortController()
    const subscribing = subscribeViaWatcherProcess(
      '/pending',
      vi.fn(),
      {},
      {
        signal: controller.signal
      }
    )
    child.connected = false
    controller.abort()
    let settled = false
    void subscribing.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await Promise.resolve()
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)

    child.emit('exit', 0, null)
    await expect(subscribing).rejects.toMatchObject({ code: 'subscribe_aborted' })
    expect(forkMock).toHaveBeenCalledTimes(2)
  })

  it('joins a cancellation deadline to active disconnect termination', async () => {
    vi.useFakeTimers()
    try {
      const siblingPromise = subscribeViaWatcherProcess('/sibling', vi.fn(), {})
      const child = currentChild()
      ackSubscribe(child)
      await siblingPromise
      const controller = new AbortController()
      const pending = subscribeViaWatcherProcess(
        '/pending',
        vi.fn(),
        {},
        {
          signal: controller.signal
        }
      )
      const pendingId = child.sent.at(-1)?.id
      child.emit('message', { op: 'subscribe-started', id: pendingId })
      controller.abort()
      const rejection = expect(pending).rejects.toMatchObject({ code: 'subscribe_aborted' })

      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_CANCEL_TIMEOUT_MS - 1)
      child.connected = false
      child.emit('disconnect')
      expect(child.kill).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1)
      expect(child.kill).toHaveBeenCalledTimes(1)
      child.emit('exit', 0, null)
      await rejection

      const replacement = currentChild()
      expect(forkMock).toHaveBeenCalledTimes(2)
      expect(replacement.sent.filter((message) => message.op === 'subscribe')).toEqual([
        expect.objectContaining({ dir: '/sibling' })
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports physical-exit failure when a timed-out recovery child cannot terminate', async () => {
    vi.useFakeTimers()
    try {
      const supervisor = createWatcherProcessSupervisor()
      let subscription: WatcherProcessSubscription
      let terminalUnsubscribeResult: Promise<unknown> | undefined
      const onTerminalError = vi.fn(() => {
        terminalUnsubscribeResult = subscription.unsubscribe().catch((error: unknown) => error)
      })
      const initial = supervisor.subscribe(
        '/stuck-recovery',
        vi.fn(),
        {},
        {
          onTerminalError,
          subscribeTimeoutMs: 100
        }
      )
      const first = currentChild()
      ackSubscribe(first)
      subscription = await initial

      first.connected = false
      first.emit('exit', null, 'SIGSEGV')
      const replacement = currentChild()
      replacement.emit('message', {
        op: 'subscribe-started',
        id: replacement.sent[0].id
      })

      await vi.advanceTimersByTimeAsync(100 + WATCHER_PROCESS_EXIT_DEADLINE_MS)

      await vi.waitFor(() => {
        expect(onTerminalError).toHaveBeenCalledTimes(1)
        expect(onTerminalError).toHaveBeenCalledWith(
          expect.objectContaining({
            code: 'process_unavailable',
            message: 'file watcher process did not exit after termination deadline',
            physicalExit: expect.any(Promise)
          })
        )
      })
      await expect(terminalUnsubscribeResult).resolves.toMatchObject({
        code: 'process_unavailable',
        physicalExit: expect.any(Promise)
      })
      expect(forkMock).toHaveBeenCalledTimes(2)
      replacement.emit('exit', 0, null)
      await Promise.resolve()
      await expect(subscription.unsubscribe()).resolves.toBeUndefined()
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a recovery timeout only after its replacement child physically exits', async () => {
    vi.useFakeTimers()
    try {
      const supervisor = createWatcherProcessSupervisor()
      const onTerminalError = vi.fn()
      const initial = supervisor.subscribe(
        '/slow-recovery',
        vi.fn(),
        {},
        {
          onTerminalError,
          subscribeTimeoutMs: 100
        }
      )
      const first = currentChild()
      ackSubscribe(first)
      const subscription = await initial

      first.connected = false
      first.emit('exit', null, 'SIGSEGV')
      const replacement = currentChild()
      replacement.emit('message', {
        op: 'subscribe-started',
        id: replacement.sent[0].id
      })

      await vi.advanceTimersByTimeAsync(100)

      expect(onTerminalError).not.toHaveBeenCalled()
      expect(replacement.kill).toHaveBeenCalledTimes(1)
      expect(forkMock).toHaveBeenCalledTimes(2)
      let unsubscribeSettled = false
      const unsubscribe = subscription.unsubscribe().then(() => {
        unsubscribeSettled = true
      })
      await Promise.resolve()
      expect(unsubscribeSettled).toBe(false)

      replacement.emit('exit', 0, null)
      await unsubscribe
      await vi.waitFor(() =>
        expect(onTerminalError).toHaveBeenCalledWith(
          expect.objectContaining({
            code: 'subscribe_timeout',
            message: 'file watcher resubscription timed out after 100ms'
          })
        )
      )
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps pending-crawl cancellation joined to disconnected child exit', async () => {
    const controller = new AbortController()
    const subscribing = subscribeViaWatcherProcess(
      '/pending',
      vi.fn(),
      {},
      {
        signal: controller.signal
      }
    )
    const child = currentChild()
    child.connected = false
    child.emit('disconnect')
    controller.abort()
    let settled = false
    void subscribing.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )

    await Promise.resolve()
    expect(settled).toBe(false)

    child.emit('exit', 0, null)
    await expect(subscribing).rejects.toMatchObject({ code: 'subscribe_aborted' })
  })

  it('reports physical-exit failure instead of early pending-crawl cancellation', async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController()
      const subscribing = subscribeViaWatcherProcess(
        '/pending',
        vi.fn(),
        {},
        {
          signal: controller.signal
        }
      )
      const child = currentChild()
      child.connected = false
      child.emit('disconnect')
      controller.abort()
      const failure = expect(subscribing).rejects.toMatchObject({
        code: 'process_unavailable',
        physicalExit: expect.any(Promise)
      })

      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_EXIT_DEADLINE_MS)

      await failure
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects unsubscribe at the physical-exit deadline', async () => {
    vi.useFakeTimers()
    try {
      const { child, unsubscribe } = await subscribePair()
      const failure = expect(unsubscribe()).rejects.toThrow(
        'file watcher process did not exit after termination deadline'
      )
      child.connected = false
      child.emit('disconnect')
      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_EXIT_DEADLINE_MS)

      await failure
      expect(forkMock).toHaveBeenCalledTimes(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('retires the child before settling a rejected native unsubscribe', async () => {
    const firstPromise = subscribeViaWatcherProcess('/first', vi.fn(), {})
    const child = currentChild()
    ackSubscribe(child)
    const first = await firstPromise
    const siblingInterruption = vi.fn()
    const siblingPromise = subscribeViaWatcherProcess(
      '/sibling',
      vi.fn(),
      {},
      {
        onInterruption: siblingInterruption
      }
    )
    ackSubscribe(child)
    await siblingPromise

    let settled = false
    const unsubscribe = first.unsubscribe().then(() => {
      settled = true
    })
    child.emit('message', { op: 'unsubscribe-failed', id: 1, message: 'native handle active' })
    await Promise.resolve()

    expect(settled).toBe(false)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(forkMock).toHaveBeenCalledTimes(1)
    child.emit('exit', 0, null)
    await unsubscribe
    await vi.waitFor(() => expect(forkMock).toHaveBeenCalledTimes(2))
    const replacement = currentChild()
    expect(replacement.sent).toContainEqual(expect.objectContaining({ dir: '/sibling' }))
    ackSubscribe(replacement)
    expect(siblingInterruption).toHaveBeenCalledTimes(1)
  })
})
