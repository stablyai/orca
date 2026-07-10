// Regression tests for issue #7547: local @parcel/watcher subscriptions run
// in a forked watcher process, and a native watcher crash must be contained —
// respawn, resubscribe, notify interruption — instead of killing the app.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { forkMock, existsSyncMock, parcelSubscribeMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  existsSyncMock: vi.fn(),
  parcelSubscribeMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({ existsSync: existsSyncMock }))
vi.mock('@parcel/watcher', () => ({ subscribe: parcelSubscribeMock }))

import {
  disposeWatcherProcess,
  resetWatcherProcessForTest,
  subscribeViaWatcherProcess
} from './parcel-watcher-process'

type SentMessage = { op: string; id: number; dir?: string }

class FakeChild extends EventEmitter {
  connected = true
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
  const result = forkMock.mock.results.at(-1)
  if (!result) {
    throw new Error('fork was not called')
  }
  return result.value as FakeChild
}

function ackSubscribe(child: FakeChild, index = -1): number {
  const message = child.sent.filter((m) => m.op === 'subscribe').at(index)
  if (!message) {
    throw new Error('no subscribe message sent')
  }
  child.emit('message', { op: 'subscribed', id: message.id })
  return message.id
}

describe('subscribeViaWatcherProcess', () => {
  beforeEach(() => {
    resetWatcherProcessForTest()
    // Why: the client deliberately runs in-process under vitest; these tests
    // exercise the forked-process mode, so hide the vitest marker.
    vi.stubEnv('VITEST', '')
    existsSyncMock.mockReturnValue(true)
    forkMock.mockImplementation(() => new FakeChild())
  })

  afterEach(() => {
    disposeWatcherProcess()
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('subscribes through the watcher process and forwards events', async () => {
    const callback = vi.fn()
    const promise = subscribeViaWatcherProcess('/repo', callback, { ignore: ['**/.git'] })
    const child = currentChild()
    expect(child.sent[0]).toMatchObject({ op: 'subscribe', dir: '/repo' })
    const id = ackSubscribe(child)
    await promise

    const events = [{ type: 'update', path: '/repo/a.txt' }]
    child.emit('message', { op: 'events', id, events })
    expect(callback).toHaveBeenCalledWith(null, events)
  })

  it('forwards watcher errors to the callback', async () => {
    const callback = vi.fn()
    const promise = subscribeViaWatcherProcess('/repo', callback, {})
    const child = currentChild()
    const id = ackSubscribe(child)
    await promise

    child.emit('message', { op: 'watch-error', id, message: 'boom' })
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }), [])
  })

  it('rejects the subscribe when the watcher process reports failure', async () => {
    const promise = subscribeViaWatcherProcess('/gone', vi.fn(), {})
    const child = currentChild()
    const id = child.sent[0].id
    child.emit('message', { op: 'subscribe-failed', id, message: 'Error opening directory' })
    await expect(promise).rejects.toThrow('Error opening directory')
  })

  it('resolves unsubscribe on the child ack', async () => {
    const promise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
    const child = currentChild()
    const id = ackSubscribe(child, 0)
    const subscription = await promise
    // Why: hold a second subscription so this unsubscribe exercises the ack
    // path instead of the last-subscriber idle kill.
    const keepAlivePromise = subscribeViaWatcherProcess('/other', vi.fn(), {})
    ackSubscribe(child)
    await keepAlivePromise

    const unsubPromise = subscription.unsubscribe()
    expect(child.sent.at(-1)).toEqual({ op: 'unsubscribe', id })
    child.emit('message', { op: 'unsubscribed', id })
    await expect(unsubPromise).resolves.toBeUndefined()
  })

  it('resolves a pending unsubscribe when the child dies', async () => {
    const promise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
    const child = currentChild()
    ackSubscribe(child, 0)
    const subscription = await promise
    const keepAlivePromise = subscribeViaWatcherProcess('/other', vi.fn(), {})
    ackSubscribe(child)
    await keepAlivePromise

    const unsubPromise = subscription.unsubscribe()
    child.connected = false
    child.emit('exit', 3221226505, null)
    await expect(unsubPromise).resolves.toBeUndefined()
  })

  it('respawns after a crash, resubscribes, and reports the interruption', async () => {
    const callback = vi.fn()
    const onInterruption = vi.fn()
    const promise = subscribeViaWatcherProcess('/repo', callback, {}, onInterruption)
    const first = currentChild()
    const id = ackSubscribe(first)
    await promise

    // Simulate the 0xc0000409 fail-fast: the watcher process dies.
    first.connected = false
    first.emit('exit', 3221226505, null)

    const second = currentChild()
    expect(second).not.toBe(first)
    expect(second.sent[0]).toMatchObject({ op: 'subscribe', id, dir: '/repo' })
    expect(onInterruption).not.toHaveBeenCalled()

    second.emit('message', { op: 'subscribed', id })
    expect(onInterruption).toHaveBeenCalledTimes(1)

    const events = [{ type: 'create', path: '/repo/b.txt' }]
    second.emit('message', { op: 'events', id, events })
    expect(callback).toHaveBeenCalledWith(null, events)
  })

  it('completes an in-flight subscribe across a crash-respawn', async () => {
    const promise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
    const first = currentChild()
    expect(first.sent[0].op).toBe('subscribe')

    first.connected = false
    first.emit('exit', 3221226505, null)

    const second = currentChild()
    ackSubscribe(second)
    await expect(promise).resolves.toMatchObject({ unsubscribe: expect.any(Function) })
  })

  it('disables watching after repeated crashes instead of fork-bombing', async () => {
    const callback = vi.fn()
    const promise = subscribeViaWatcherProcess('/repo', callback, {})
    ackSubscribe(currentChild())
    await promise

    for (let crash = 0; crash < 2; crash++) {
      const child = currentChild()
      child.connected = false
      child.emit('exit', 3221226505, null)
      ackSubscribe(currentChild())
    }
    expect(forkMock).toHaveBeenCalledTimes(3)

    const last = currentChild()
    last.connected = false
    last.emit('exit', 3221226505, null)

    expect(forkMock).toHaveBeenCalledTimes(3)
    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('crashed repeatedly') }),
      []
    )
  })

  it('kills the idle child after the last unsubscribe and respawns on the next subscribe', async () => {
    const promise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
    const first = currentChild()
    ackSubscribe(first)
    const subscription = await promise

    await expect(subscription.unsubscribe()).resolves.toBeUndefined()
    expect(first.kill).toHaveBeenCalledTimes(1)

    // Why: the deliberate idle kill must not count as a crash — no respawn
    // and no crash-fuse advance when the killed child's exit event lands.
    first.connected = false
    first.emit('exit', null, 'SIGTERM')
    expect(forkMock).toHaveBeenCalledTimes(1)

    const respawnPromise = subscribeViaWatcherProcess('/repo2', vi.fn(), {})
    expect(forkMock).toHaveBeenCalledTimes(2)
    const second = currentChild()
    expect(second).not.toBe(first)
    expect(second.sent[0]).toMatchObject({ op: 'subscribe', dir: '/repo2' })
    ackSubscribe(second)
    await expect(respawnPromise).resolves.toMatchObject({ unsubscribe: expect.any(Function) })
  })

  it('kills the idle child when the last pending subscribe fails', async () => {
    const promise = subscribeViaWatcherProcess('/gone', vi.fn(), {})
    const first = currentChild()
    first.emit('message', {
      op: 'subscribe-failed',
      id: first.sent[0].id,
      message: 'Error opening directory'
    })
    await expect(promise).rejects.toThrow('Error opening directory')
    expect(first.kill).toHaveBeenCalledTimes(1)

    const respawnPromise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
    expect(forkMock).toHaveBeenCalledTimes(2)
    ackSubscribe(currentChild())
    await expect(respawnPromise).resolves.toMatchObject({ unsubscribe: expect.any(Function) })
  })

  it('keeps the child alive when a subscribe fails while other subscriptions remain', async () => {
    const firstPromise = subscribeViaWatcherProcess('/a', vi.fn(), {})
    const child = currentChild()
    ackSubscribe(child)
    await firstPromise

    const failingPromise = subscribeViaWatcherProcess('/gone', vi.fn(), {})
    child.emit('message', { op: 'subscribe-failed', id: child.sent.at(-1)!.id, message: 'boom' })
    await expect(failingPromise).rejects.toThrow('boom')
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('keeps the child alive while other subscriptions remain', async () => {
    const firstPromise = subscribeViaWatcherProcess('/a', vi.fn(), {})
    const child = currentChild()
    ackSubscribe(child)
    const first = await firstPromise
    const secondPromise = subscribeViaWatcherProcess('/b', vi.fn(), {})
    ackSubscribe(child)
    const second = await secondPromise

    const firstUnsub = first.unsubscribe()
    expect(child.kill).not.toHaveBeenCalled()
    expect(child.sent.at(-1)).toMatchObject({ op: 'unsubscribe' })

    // The last unsubscribe kills the idle child, which also completes the
    // still-pending unsubscribe ack from the first record.
    const secondUnsub = second.unsubscribe()
    expect(child.kill).toHaveBeenCalledTimes(1)
    await expect(firstUnsub).resolves.toBeUndefined()
    await expect(secondUnsub).resolves.toBeUndefined()
  })

  it('uses the in-process watcher under vitest', async () => {
    vi.stubEnv('VITEST', 'true')
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    parcelSubscribeMock.mockResolvedValue({ unsubscribe })
    const callback = vi.fn()

    const subscription = await subscribeViaWatcherProcess('/repo', callback, {
      ignore: ['**/.git']
    })
    expect(forkMock).not.toHaveBeenCalled()
    expect(parcelSubscribeMock).toHaveBeenCalledWith('/repo', callback, { ignore: ['**/.git'] })
    await subscription.unsubscribe()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
