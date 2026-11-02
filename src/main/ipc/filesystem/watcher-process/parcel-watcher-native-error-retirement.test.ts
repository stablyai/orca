import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acknowledgeWatcherSubscribe,
  currentWatcherChild,
  FakeWatcherChild,
  trackPromiseSettlement
} from './parcel-watcher-process-test-child'

const { forkMock } = vi.hoisted(() => ({ forkMock: vi.fn() }))
vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({
  existsSync: () => true,
  mkdtempSync: () => '/tmp/orca-watcher-retirement-test',
  rmSync: vi.fn()
}))

import { WatcherProcessSupervisor } from './parcel-watcher-process-supervisor'
import { WATCHER_PROCESS_EXIT_DEADLINE_MS } from './parcel-watcher-child-termination'

describe('native watcher error retirement', () => {
  let supervisor: WatcherProcessSupervisor

  beforeEach(() => {
    forkMock.mockReset().mockImplementation(() => new FakeWatcherChild())
    supervisor = new WatcherProcessSupervisor({ useInProcessVitestFallback: false })
  })

  afterEach(() => supervisor.dispose())

  it('closes only the failed handle before recovery and joins concurrent unsubscribe', async () => {
    const callback = vi.fn()
    const onTerminalError = vi.fn()
    const pending = supervisor.subscribe('/repo', callback, {}, { onTerminalError })
    const child = currentWatcherChild(forkMock)
    const id = acknowledgeWatcherSubscribe(child)
    const subscription = await pending
    const keepAlive = supervisor.subscribe('/other', vi.fn(), {})
    const otherId = acknowledgeWatcherSubscribe(child)
    await keepAlive

    child.emit('message', { op: 'watch-error', id, message: 'native watcher stopped' })
    expect(child.sent.at(-1)).toEqual({ op: 'unsubscribe', id })
    expect(onTerminalError).not.toHaveBeenCalled()
    expect(callback).not.toHaveBeenCalled()
    const closing = subscription.unsubscribe()
    const closed = trackPromiseSettlement(closing)
    child.emit('message', { op: 'watch-error', id, message: 'duplicate error' })
    child.emit('message', { op: 'events', id, events: [{ type: 'update', path: '/repo/stale' }] })
    await Promise.resolve()
    expect(closed()).toBe(false)
    expect(child.sent.filter((message) => message.op === 'unsubscribe')).toHaveLength(1)

    child.emit('message', { op: 'unsubscribed', id })
    await closing
    await vi.waitFor(() => expect(onTerminalError).toHaveBeenCalledTimes(1))
    expect(onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'native watcher stopped' })
    )
    expect(callback).not.toHaveBeenCalled()
    expect(child.kill).not.toHaveBeenCalled()

    child.connected = false
    child.emit('exit', 1, null)
    const replacement = currentWatcherChild(forkMock)
    expect(replacement.sent).toEqual([
      expect.objectContaining({ op: 'subscribe', id: otherId, dir: '/other' })
    ])
  })

  it('waits for physical exit before reporting the last failed subscription', async () => {
    const callback = vi.fn()
    const pending = supervisor.subscribe('/repo', callback, {})
    const child = currentWatcherChild(forkMock)
    const id = acknowledgeWatcherSubscribe(child)
    const subscription = await pending

    child.emit('message', { op: 'watch-error', id, message: 'root removed' })
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(callback).not.toHaveBeenCalled()
    const closing = subscription.unsubscribe()
    const closed = trackPromiseSettlement(closing)
    await Promise.resolve()
    expect(closed()).toBe(false)
    child.emit('exit', 0, null)
    await closing
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ message: 'root removed' }), [])
    expect(forkMock).toHaveBeenCalledTimes(1)
  })

  it('suppresses delayed recovery after supervisor disposal', async () => {
    const onTerminalError = vi.fn()
    const pending = supervisor.subscribe('/repo', vi.fn(), {}, { onTerminalError })
    const child = currentWatcherChild(forkMock)
    const id = acknowledgeWatcherSubscribe(child)
    await pending
    const keepAlive = supervisor.subscribe('/other', vi.fn(), {})
    acknowledgeWatcherSubscribe(child)
    await keepAlive
    child.emit('message', { op: 'watch-error', id, message: 'native watcher stopped' })
    supervisor.dispose()
    child.emit('message', { op: 'unsubscribed', id })
    await Promise.resolve()
    await Promise.resolve()
    expect(onTerminalError).not.toHaveBeenCalled()
  })

  it('fences replacement behind physical exit when termination misses its deadline', async () => {
    vi.useFakeTimers()
    try {
      const onTerminalError = vi.fn()
      const pending = supervisor.subscribe('/repo', vi.fn(), {}, { onTerminalError })
      const child = currentWatcherChild(forkMock)
      const id = acknowledgeWatcherSubscribe(child)
      const subscription = await pending
      child.emit('message', { op: 'watch-error', id, message: 'native watcher stopped' })
      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_EXIT_DEADLINE_MS)

      expect(onTerminalError).toHaveBeenCalledTimes(1)
      const error = onTerminalError.mock.calls[0]?.[0]
      expect(error).toMatchObject({ scope: 'supervisor', physicalExit: expect.any(Promise) })
      let exited = false
      void error.physicalExit.then(() => {
        exited = true
      })
      await expect(subscription.unsubscribe()).rejects.toBe(error)
      expect(exited).toBe(false)
      child.emit('exit', 0, null)
      await error.physicalExit
      expect(exited).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the removed owner when shared-child teardown misses its exit deadline', async () => {
    vi.useFakeTimers()
    try {
      const onTerminalError = vi.fn()
      const pending = supervisor.subscribe('/repo', vi.fn(), {}, { onTerminalError })
      const child = currentWatcherChild(forkMock)
      const id = acknowledgeWatcherSubscribe(child)
      const subscription = await pending
      const otherTerminalError = vi.fn()
      const other = supervisor.subscribe(
        '/other',
        vi.fn(),
        {},
        { onTerminalError: otherTerminalError }
      )
      acknowledgeWatcherSubscribe(child)
      await other
      child.emit('message', { op: 'watch-error', id, message: 'native watcher stopped' })
      child.emit('message', { op: 'unsubscribe-failed', id, message: 'native teardown failed' })
      await vi.advanceTimersByTimeAsync(WATCHER_PROCESS_EXIT_DEADLINE_MS)

      expect(onTerminalError).toHaveBeenCalledTimes(1)
      expect(otherTerminalError).toHaveBeenCalledTimes(1)
      const error = onTerminalError.mock.calls[0]?.[0]
      expect(error).toMatchObject({ scope: 'supervisor', physicalExit: expect.any(Promise) })
      await expect(subscription.unsubscribe()).rejects.toBe(error)
      child.emit('exit', 0, null)
      await error.physicalExit
    } finally {
      vi.useRealTimers()
    }
  })
})
