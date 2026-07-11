import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { ensureRuntimeMock, spawnMock } = vi.hoisted(() => ({
  ensureRuntimeMock: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('./filesystem-watcher-wsl-runtime', () => ({
  ensureWslWatcherRuntime: ensureRuntimeMock
}))

import {
  resetWslWatcherHostsForTest,
  subscribeViaWslWatcherHost,
  WslWatcherTopologyError,
  type WslHostSubscriptionContext
} from './filesystem-watcher-wsl-host-client'

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  stdinData = ''
  kill = vi.fn(() => true)

  constructor() {
    super()
    this.stdin.on('data', (chunk: Buffer) => {
      this.stdinData += chunk.toString('utf8')
    })
  }
}

function context(
  linuxPath: string,
  onStopped = vi.fn()
): WslHostSubscriptionContext & { onStopped: ReturnType<typeof vi.fn> } {
  return {
    distro: 'Ubuntu',
    linuxPath,
    ignoreDirs: ['node_modules'],
    onEvents: vi.fn(),
    onOverflow: vi.fn(),
    onStopped
  }
}

function writeMessage(child: FakeChildProcess, message: object): void {
  child.stdout.write(`${JSON.stringify(message)}\n`)
}

function subscribeMessages(child: FakeChildProcess): { id: number; dir: string }[] {
  return child.stdinData
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { op: string; id: number; dir: string })
    .filter((message) => message.op === 'subscribe')
}

async function readySubscription(
  child: FakeChildProcess,
  linuxPath: string,
  onStopped = vi.fn()
): Promise<Awaited<ReturnType<typeof subscribeViaWslWatcherHost>>> {
  const pending = subscribeViaWslWatcherHost(context(linuxPath, onStopped))
  await vi.waitFor(() => expect(spawnMock).toHaveBeenCalled())
  writeMessage(child, { op: 'ready', protocol: 1 })
  await vi.waitFor(() => expect(subscribeMessages(child)).toHaveLength(1))
  writeMessage(child, { op: 'subscribed', id: subscribeMessages(child)[0]!.id })
  return pending
}

describe('managed WSL host lifecycle', () => {
  beforeEach(() => {
    spawnMock.mockReset()
    ensureRuntimeMock.mockReset().mockResolvedValue({
      nodePath: '/home/me/.local/share/orca/wsl-watcher/version/x64/node',
      hostPath: '/home/me/.local/share/orca/wsl-watcher/version/x64/host.js'
    })
  })

  afterEach(() => {
    resetWslWatcherHostsForTest()
    vi.restoreAllMocks()
  })

  it.each(['stdin', 'stdout'] as const)(
    'contains asynchronous child %s errors instead of crashing main',
    async (streamName) => {
      const child = new FakeChildProcess()
      const onStopped = vi.fn()
      spawnMock.mockReturnValueOnce(child)
      const subscription = await readySubscription(child, '/home/me/repo', onStopped)

      expect(() => child[streamName].emit('error', new Error(`${streamName} failed`))).not.toThrow()
      expect(child.kill).toHaveBeenCalled()
      expect(onStopped).toHaveBeenCalledOnce()
      subscription.unsubscribe()
    }
  )

  it('contains diagnostic stderr errors without stopping a healthy host', async () => {
    const child = new FakeChildProcess()
    const onStopped = vi.fn()
    spawnMock.mockReturnValueOnce(child)
    const subscription = await readySubscription(child, '/home/me/repo', onStopped)

    expect(() => child.stderr.emit('error', new Error('stderr failed'))).not.toThrow()
    expect(onStopped).not.toHaveBeenCalled()
    subscription.unsubscribe()
  })

  it('reuses one live host for mixed-case distro subscriptions', async () => {
    const child = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(child)
    const first = await readySubscription(child, '/home/me/repo')

    const secondPending = subscribeViaWslWatcherHost({
      ...context('/home/me/other'),
      distro: 'ubuntu'
    })
    await vi.waitFor(() => expect(subscribeMessages(child)).toHaveLength(2))
    writeMessage(child, { op: 'subscribed', id: subscribeMessages(child)[1]!.id })
    const second = await secondPending

    expect(spawnMock).toHaveBeenCalledOnce()
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(['-d', 'Ubuntu']))
    first.unsubscribe()
    expect(child.kill).not.toHaveBeenCalled()
    second.unsubscribe()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('canonicalizes roots without changing Linux path case', async () => {
    const child = new FakeChildProcess()
    const subscriptionContext = context('/home//me/Repo/./nested/../')
    const onEvents = vi.fn()
    subscriptionContext.onEvents = onEvents
    spawnMock.mockReturnValueOnce(child)
    const pending = subscribeViaWslWatcherHost(subscriptionContext)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    writeMessage(child, { op: 'ready', protocol: 1 })
    await vi.waitFor(() => expect(subscribeMessages(child)).toHaveLength(1))
    const [{ id, dir }] = subscribeMessages(child)
    expect(dir).toBe('/home/me/Repo')
    writeMessage(child, { op: 'subscribed', id })
    const subscription = await pending

    writeMessage(child, {
      op: 'events',
      id,
      events: [
        { type: 'update', path: '/home/me/Repo/file.md' },
        { type: 'update', path: '/home/me/repo/wrong-case.md' }
      ]
    })
    await vi.waitFor(() => expect(onEvents).toHaveBeenCalledOnce())
    expect(onEvents).toHaveBeenCalledWith([
      { type: 'update', path: '\\\\wsl.localhost\\Ubuntu\\home\\me\\Repo\\file.md' }
    ])
    subscription.unsubscribe()
  })

  it('does not let a cancelled acquisition kill another startup waiter', async () => {
    const child = new FakeChildProcess()
    const abortController = new AbortController()
    let resolveRuntime!: (runtime: { nodePath: string; hostPath: string }) => void
    let bootstrapSignal!: AbortSignal
    ensureRuntimeMock.mockReset().mockImplementation((_distro, signal: AbortSignal) => {
      bootstrapSignal = signal
      return new Promise((resolve) => {
        resolveRuntime = resolve
      })
    })
    spawnMock.mockReturnValueOnce(child)
    const cancelled = subscribeViaWslWatcherHost(
      context('/home/me/cancelled'),
      abortController.signal
    )
    const cancelledResult = cancelled.then(
      () => null,
      (error: unknown) => error
    )
    const retained = subscribeViaWslWatcherHost(context('/home/me/retained'))
    await vi.waitFor(() => expect(ensureRuntimeMock).toHaveBeenCalledOnce())
    abortController.abort()
    expect(bootstrapSignal.aborted).toBe(false)

    resolveRuntime({ nodePath: '/managed/node', hostPath: '/managed/host.js' })
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    writeMessage(child, { op: 'ready', protocol: 1 })
    await vi.waitFor(() => expect(subscribeMessages(child)).toHaveLength(1))
    writeMessage(child, { op: 'subscribed', id: subscribeMessages(child)[0]!.id })

    await expect(cancelledResult).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining('cancelled') })
    )
    const subscription = await retained
    expect(child.kill).not.toHaveBeenCalled()
    subscription.unsubscribe()
    expect(child.kill).toHaveBeenCalledOnce()
  })

  it('does not spawn an orphan host when every waiter cancels during runtime setup', async () => {
    let bootstrapSignal!: AbortSignal
    ensureRuntimeMock.mockReset().mockImplementation((_distro, signal: AbortSignal) => {
      bootstrapSignal = signal
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('runtime cancelled')), {
          once: true
        })
      })
    })
    const abortController = new AbortController()
    const pending = subscribeViaWslWatcherHost(context('/home/me/repo'), abortController.signal)
    const result = pending.catch((error: unknown) => error)
    await vi.waitFor(() => expect(ensureRuntimeMock).toHaveBeenCalledOnce())
    abortController.abort()
    await expect(result).resolves.toEqual(
      expect.objectContaining({ message: expect.stringContaining('cancelled') })
    )

    expect(bootstrapSignal.aborted).toBe(true)
    await new Promise((resolve) => setImmediate(resolve))
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('propagates topology stops without classifying them as host failures', async () => {
    const child = new FakeChildProcess()
    const subscriptionContext = context('/home/me/repo')
    spawnMock.mockReturnValueOnce(child)
    const pending = subscribeViaWslWatcherHost(subscriptionContext)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    writeMessage(child, { op: 'ready', protocol: 1 })
    await vi.waitFor(() => expect(subscribeMessages(child)).toHaveLength(1))
    const [{ id }] = subscribeMessages(child)
    writeMessage(child, { op: 'subscribed', id })
    await pending

    writeMessage(child, {
      op: 'watch-error',
      id,
      reason: 'topology',
      message: 'recursive topology changed'
    })

    await vi.waitFor(() => expect(subscriptionContext.onStopped).toHaveBeenCalledWith('topology'))
    expect(subscriptionContext.onOverflow).toHaveBeenCalledOnce()
  })

  it('marks overflow when topology changes before subscription readiness', async () => {
    const child = new FakeChildProcess()
    const subscriptionContext = context('/home/me/repo')
    spawnMock.mockReturnValueOnce(child)
    const pending = subscribeViaWslWatcherHost(subscriptionContext)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    writeMessage(child, { op: 'ready', protocol: 1 })
    await vi.waitFor(() => expect(subscribeMessages(child)).toHaveLength(1))
    const [{ id }] = subscribeMessages(child)

    writeMessage(child, {
      op: 'watch-error',
      id,
      reason: 'topology',
      message: 'topology changed while attaching'
    })

    await expect(pending).rejects.toBeInstanceOf(WslWatcherTopologyError)
    expect(subscriptionContext.onOverflow).toHaveBeenCalledOnce()
    expect(subscriptionContext.onStopped).not.toHaveBeenCalled()
  })

  it('ignores a failed old child closing after its replacement is live', async () => {
    const oldChild = new FakeChildProcess()
    const liveChild = new FakeChildProcess()
    spawnMock.mockReturnValueOnce(oldChild).mockReturnValueOnce(liveChild)
    const failed = subscribeViaWslWatcherHost(context('/home/me/failed'))
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce())
    oldChild.stdout.write('{invalid-json}\n')
    await expect(failed).rejects.toThrow()

    const second = await readySubscription(liveChild, '/home/me/second')
    oldChild.emit('close', 1, null)
    const thirdPending = subscribeViaWslWatcherHost(context('/home/me/third'))
    await vi.waitFor(() => expect(subscribeMessages(liveChild)).toHaveLength(2))
    writeMessage(liveChild, { op: 'subscribed', id: subscribeMessages(liveChild)[1]!.id })
    const third = await thirdPending

    expect(spawnMock).toHaveBeenCalledTimes(2)
    second.unsubscribe()
    third.unsubscribe()
  })
})
