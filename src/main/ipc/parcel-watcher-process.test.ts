// Regression tests for issue #7547: local @parcel/watcher subscriptions run
// in a forked watcher process, and a native watcher crash must be contained —
// respawn, resubscribe, notify interruption — instead of killing the app.
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  forkMock,
  existsSyncMock,
  mkdtempSyncMock,
  parcelSubscribeMock,
  rmSyncMock,
  writeFileSyncMock
} = vi.hoisted(() => ({
  forkMock: vi.fn(),
  existsSyncMock: vi.fn(),
  mkdtempSyncMock: vi.fn(() => '/tmp/orca-watcher-canary-supervisor-test'),
  parcelSubscribeMock: vi.fn(),
  rmSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ fork: forkMock }))
vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
  mkdtempSync: mkdtempSyncMock,
  rmSync: rmSyncMock,
  writeFileSync: writeFileSyncMock
}))
vi.mock('@parcel/watcher', () => ({ subscribe: parcelSubscribeMock }))

import {
  createWatcherProcessSupervisor,
  disposeWatcherProcess,
  resetRuntimeWatcherProcessForTest,
  resetWatcherProcessForTest,
  subscribeViaRuntimeWatcherProcess,
  subscribeViaWatcherProcess
} from './parcel-watcher-process'

type SentMessage = { op: string; id: number; dir?: string }

class FakeChild extends EventEmitter {
  connected = true
  pid = 1234
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
    resetRuntimeWatcherProcessForTest()
    // Why: the client deliberately runs in-process under vitest; these tests
    // exercise the forked-process mode, so hide the vitest marker.
    vi.stubEnv('VITEST', '')
    existsSyncMock.mockReturnValue(true)
    forkMock.mockImplementation(() => new FakeChild())
  })

  afterEach(() => {
    disposeWatcherProcess()
    resetRuntimeWatcherProcessForTest()
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

  it('creates the fault-harness pid file without clobbering an existing path', async () => {
    vi.stubEnv('ORCA_WATCHER_CHILD_PID_FILE', '/tmp/orca-watcher.pid')

    const promise = subscribeViaWatcherProcess('/repo', vi.fn(), {})
    const child = currentChild()

    expect(writeFileSyncMock).toHaveBeenCalledWith('/tmp/orca-watcher.pid', '1234', {
      flag: 'wx'
    })
    ackSubscribe(child)
    await promise
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

  it('reports a terminal resubscribe failure separately from recoverable watch errors', async () => {
    const callback = vi.fn()
    const onTerminalError = vi.fn()
    const promise = subscribeViaWatcherProcess('/repo', callback, {}, { onTerminalError })
    const child = currentChild()
    const id = ackSubscribe(child)
    await promise

    child.emit('message', { op: 'subscribe-failed', id, message: 'root unavailable' })

    expect(onTerminalError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'root unavailable' })
    )
    expect(callback).not.toHaveBeenCalled()
  })

  it('passes bounded event-delivery options to the watcher child', async () => {
    const promise = subscribeViaWatcherProcess(
      '/repo',
      vi.fn(),
      {},
      {
        delivery: { includeDirectoryMetadata: true, maxEventsPerBatch: 200 }
      }
    )
    const child = currentChild()

    expect(child.sent[0]).toMatchObject({
      op: 'subscribe',
      dir: '/repo',
      delivery: { includeDirectoryMetadata: true, maxEventsPerBatch: 200 }
    })
    ackSubscribe(child)
    await promise
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
    const promise = subscribeViaWatcherProcess('/repo', callback, {}, { onInterruption })
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

  it('recovers existing records when IPC disconnects before child exit', async () => {
    const firstPromise = subscribeViaWatcherProcess('/existing', vi.fn(), {})
    const first = currentChild()
    ackSubscribe(first)
    await firstPromise

    first.connected = false
    first.emit('disconnect')
    const replacement = currentChild()
    const secondPromise = subscribeViaWatcherProcess('/new', vi.fn(), {})

    expect(replacement).not.toBe(first)
    expect(replacement.sent.filter((message) => message.op === 'subscribe')).toEqual([
      expect.objectContaining({ dir: '/existing' }),
      expect.objectContaining({ dir: '/new' })
    ])
    ackSubscribe(replacement, 0)
    ackSubscribe(replacement, 1)
    await secondPromise
  })

  it('spreads runtime roots across healthy children and contains a shard crash', async () => {
    const firstInterruption = vi.fn()
    const secondInterruption = vi.fn()
    const firstPromise = subscribeViaRuntimeWatcherProcess(
      '/repo-a',
      vi.fn(),
      {},
      {
        onInterruption: firstInterruption
      }
    )
    const firstChild = currentChild()
    ackSubscribe(firstChild)
    await firstPromise

    const secondPromise = subscribeViaRuntimeWatcherProcess(
      '/repo-b',
      vi.fn(),
      {},
      {
        onInterruption: secondInterruption
      }
    )
    const secondChild = currentChild()
    expect(secondChild).not.toBe(firstChild)
    ackSubscribe(secondChild)
    await secondPromise
    expect(forkMock).toHaveBeenCalledTimes(2)

    firstChild.connected = false
    firstChild.emit('exit', null, 'SIGSEGV')

    const replacement = currentChild()
    expect(replacement).not.toBe(firstChild)
    expect(replacement.sent.filter((message) => message.op === 'subscribe')).toHaveLength(1)
    ackSubscribe(replacement)
    expect(firstInterruption).toHaveBeenCalledTimes(1)
    expect(secondInterruption).not.toHaveBeenCalled()
    expect(secondChild.connected).toBe(true)
  })

  it('completes an in-flight subscribe across a crash-respawn', async () => {
    const onInterruption = vi.fn()
    const promise = subscribeViaWatcherProcess('/repo', vi.fn(), {}, { onInterruption })
    const first = currentChild()
    expect(first.sent[0].op).toBe('subscribe')

    first.connected = false
    first.emit('exit', 3221226505, null)

    const second = currentChild()
    ackSubscribe(second)
    await expect(promise).resolves.toMatchObject({ unsubscribe: expect.any(Function) })
    expect(onInterruption).toHaveBeenCalledTimes(1)
  })

  it('cancels a queued crawl without restarting healthy roots', async () => {
    const healthyInterruption = vi.fn()
    const healthyPromise = subscribeViaWatcherProcess(
      '/healthy',
      vi.fn(),
      {},
      {
        onInterruption: healthyInterruption
      }
    )
    const child = currentChild()
    ackSubscribe(child)
    await healthyPromise

    const controller = new AbortController()
    const pending = subscribeViaWatcherProcess(
      '/queued',
      vi.fn(),
      {},
      {
        signal: controller.signal
      }
    )
    const queuedId = child.sent.at(-1)?.id
    controller.abort()

    await expect(pending).rejects.toThrow('aborted')
    expect(child.kill).not.toHaveBeenCalled()
    expect(child.sent.at(-1)).toEqual({ op: 'cancel-subscribe', id: queuedId })
    expect(healthyInterruption).not.toHaveBeenCalled()
  })

  it('cancels an active crawl and restores healthy roots when its owner aborts', async () => {
    const healthyInterruption = vi.fn()
    const healthyPromise = subscribeViaWatcherProcess(
      '/healthy',
      vi.fn(),
      {},
      {
        onInterruption: healthyInterruption
      }
    )
    const first = currentChild()
    ackSubscribe(first)
    await healthyPromise

    const controller = new AbortController()
    const pending = subscribeViaWatcherProcess('/slow', vi.fn(), {}, { signal: controller.signal })
    first.emit('message', { op: 'subscribe-started', id: first.sent.at(-1)?.id })
    controller.abort()

    await expect(pending).rejects.toThrow('aborted')
    expect(first.kill).toHaveBeenCalledTimes(1)
    const replacement = currentChild()
    expect(replacement).not.toBe(first)
    expect(replacement.sent.filter((message) => message.op === 'subscribe')).toEqual([
      expect.objectContaining({ dir: '/healthy' })
    ])
    ackSubscribe(replacement)
    expect(healthyInterruption).toHaveBeenCalledTimes(1)
  })

  it('bounds a pending crawl and restores healthy roots after setup timeout', async () => {
    vi.useFakeTimers()
    try {
      const healthyInterruption = vi.fn()
      const healthyPromise = subscribeViaWatcherProcess(
        '/healthy',
        vi.fn(),
        {},
        {
          onInterruption: healthyInterruption
        }
      )
      const first = currentChild()
      ackSubscribe(first)
      await healthyPromise

      const pending = subscribeViaWatcherProcess('/slow', vi.fn(), {}, { subscribeTimeoutMs: 100 })
      first.emit('message', { op: 'subscribe-started', id: first.sent.at(-1)?.id })
      const timedOut = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(100)

      await timedOut
      const replacement = currentChild()
      expect(replacement).not.toBe(first)
      ackSubscribe(replacement)
      expect(healthyInterruption).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends a root whose crash resubscription crawl exceeds its deadline', async () => {
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
      await initial

      first.connected = false
      first.emit('exit', null, 'SIGSEGV')
      const replacement = currentChild()
      replacement.emit('message', {
        op: 'subscribe-started',
        id: replacement.sent[0].id
      })

      await vi.advanceTimersByTimeAsync(100)

      expect(onTerminalError).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'subscribe_timeout',
          message: 'file watcher resubscription timed out after 100ms'
        })
      )
      expect(replacement.kill).toHaveBeenCalledTimes(1)
      expect(forkMock).toHaveBeenCalledTimes(2)
      supervisor.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('starts the setup timeout only when the child begins that crawl', async () => {
    vi.useFakeTimers()
    try {
      const pending = subscribeViaWatcherProcess(
        '/queued',
        vi.fn(),
        {},
        {
          subscribeTimeoutMs: 100
        }
      )
      const child = currentChild()
      let settled = false
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )

      await vi.advanceTimersByTimeAsync(100)
      expect(settled).toBe(false)
      expect(child.kill).not.toHaveBeenCalled()

      child.emit('message', { op: 'subscribe-started', id: child.sent.at(-1)?.id })
      const timedOut = expect(pending).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(100)
      await timedOut
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects an in-flight and later subscribe when the supervisor is disposed', async () => {
    const supervisor = createWatcherProcessSupervisor()
    const pending = supervisor.subscribe('/repo', vi.fn(), {})
    const child = currentChild()

    supervisor.dispose()

    await expect(pending).rejects.toThrow('supervisor disposed')
    await expect(supervisor.subscribe('/later', vi.fn(), {})).rejects.toThrow('supervisor disposed')
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(forkMock).toHaveBeenCalledTimes(1)
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
    expect(rmSyncMock).toHaveBeenCalledWith('/tmp/orca-watcher-canary-supervisor-test', {
      recursive: true,
      force: true
    })

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
    expect(parcelSubscribeMock).toHaveBeenCalledWith('/repo', expect.any(Function), {
      ignore: ['**/.git']
    })
    await subscription.unsubscribe()
    expect(unsubscribe).toHaveBeenCalled()
  })

  it('rejects a pre-aborted in-process subscribe before loading Parcel', async () => {
    vi.stubEnv('VITEST', 'true')
    const controller = new AbortController()
    controller.abort()

    await expect(
      subscribeViaWatcherProcess('/repo', vi.fn(), {}, { signal: controller.signal })
    ).rejects.toThrow('aborted')
    expect(parcelSubscribeMock).not.toHaveBeenCalled()
  })

  it('releases a late in-process subscription after pending setup is aborted', async () => {
    vi.stubEnv('VITEST', 'true')
    const unsubscribe = vi.fn().mockResolvedValue(undefined)
    let resolveSubscription!: (subscription: { unsubscribe: typeof unsubscribe }) => void
    parcelSubscribeMock.mockReturnValue(
      new Promise((resolve) => {
        resolveSubscription = resolve
      })
    )
    const controller = new AbortController()
    const pending = subscribeViaWatcherProcess('/repo', vi.fn(), {}, { signal: controller.signal })

    await vi.waitFor(() => expect(parcelSubscribeMock).toHaveBeenCalledTimes(1))
    controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    resolveSubscription({ unsubscribe })

    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1))
  })

  it('fails closed when the isolated watcher entry is absent outside tests', async () => {
    existsSyncMock.mockReturnValue(false)

    await expect(subscribeViaWatcherProcess('/repo', vi.fn(), {})).rejects.toThrow(
      'watcher process entry is missing'
    )
    expect(forkMock).not.toHaveBeenCalled()
    expect(parcelSubscribeMock).not.toHaveBeenCalled()
  })

  it('starts without a canary when the diagnostic temp directory is unavailable', async () => {
    mkdtempSyncMock.mockImplementationOnce(() => {
      throw new Error('read-only temp directory')
    })

    const pending = subscribeViaWatcherProcess('/repo', vi.fn(), {})
    const child = currentChild()
    const forkOptions = forkMock.mock.calls.at(-1)?.[2] as { env?: NodeJS.ProcessEnv } | undefined
    expect(forkOptions?.env?.ORCA_WATCHER_CANARY_DIR).toBeUndefined()
    ackSubscribe(child)
    await expect(pending).resolves.toMatchObject({ unsubscribe: expect.any(Function) })
  })

  it('keeps independently-created supervisors in separate crash-fuse domains', async () => {
    const firstSupervisor = createWatcherProcessSupervisor()
    const secondSupervisor = createWatcherProcessSupervisor()
    const firstCallback = vi.fn()
    const secondCallback = vi.fn()

    const firstPromise = firstSupervisor.subscribe('/faulting', firstCallback, {})
    const firstChild = currentChild()
    ackSubscribe(firstChild)
    await firstPromise

    const secondPromise = secondSupervisor.subscribe('/healthy', secondCallback, {})
    const secondChild = currentChild()
    ackSubscribe(secondChild)
    await secondPromise

    let faultingChild = firstChild
    for (let crash = 0; crash < 2; crash++) {
      faultingChild.connected = false
      faultingChild.emit('exit', null, 'SIGSEGV')
      faultingChild = currentChild()
      ackSubscribe(faultingChild)
    }
    faultingChild.connected = false
    faultingChild.emit('exit', null, 'SIGSEGV')

    expect(firstCallback).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('crashed repeatedly') }),
      []
    )
    expect(secondCallback).not.toHaveBeenCalled()
    expect(secondChild.connected).toBe(true)

    firstSupervisor.dispose()
    secondSupervisor.dispose()
  })
})
