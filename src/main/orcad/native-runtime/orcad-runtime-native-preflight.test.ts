import { EventEmitter } from 'node:events'
import type * as ChildProcessModule from 'node:child_process'
import type * as FsModule from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { forkMock, existsSyncMock } = vi.hoisted(() => ({
  forkMock: vi.fn(),
  existsSyncMock: vi.fn()
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof ChildProcessModule>()),
  fork: forkMock
}))
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof FsModule>()),
  existsSync: existsSyncMock
}))
vi.mock('../../daemon/pty-subprocess/spawn-preflight', () => ({
  PtySpawnHealthTimeoutError: class extends Error {},
  PTY_SPAWN_HEALTH_TIMEOUT_MS: 1,
  runPtySpawnHealthProbe: vi.fn(async () => {})
}))

import { preflightOrcadNativeRuntime } from './orcad-runtime-native-preflight'

// Mirrors a native watcher that never delivers the ready event and only exits when killed.
class StalledWatcherChild extends EventEmitter {
  connected = true
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  stderr = new EventEmitter()
  kill = vi.fn(() => {
    this.connected = false
    queueMicrotask(() => this.emit('exit', null, 'SIGKILL'))
    return true
  })
  constructor(private readonly subscribeReply: 'none' | 'subscribed' | 'watch-error') {
    super()
  }
  send = vi.fn((message: { op: string; id: number }) => {
    if (message.op === 'subscribe' && this.subscribeReply === 'subscribed') {
      queueMicrotask(() => this.emit('message', { op: 'subscribed', id: message.id }))
    } else if (message.op === 'subscribe' && this.subscribeReply === 'watch-error') {
      queueMicrotask(() => {
        this.emit('message', { op: 'subscribe-started', id: message.id })
        this.emit('message', { op: 'watch-error', id: message.id, message: 'inotify_init failed' })
      })
    } else if (message.op === 'unsubscribe') {
      queueMicrotask(() => this.emit('message', { op: 'unsubscribed', id: message.id }))
    } else if (message.op === 'cancel-subscribe' && this.subscribeReply !== 'watch-error') {
      queueMicrotask(() => this.emit('message', { op: 'cancel-requires-restart', id: message.id }))
    }
    return true
  })
}

const realPlatform = process.platform

describe('preflightOrcadNativeRuntime watcher readiness', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    existsSyncMock.mockReturnValue(true)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function runPreflightFor(elapsedMs: number): Promise<unknown> {
    const preflight = preflightOrcadNativeRuntime().then(
      () => undefined,
      (error: unknown) => error
    )
    while (forkMock.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve))
    }
    await vi.advanceTimersByTimeAsync(elapsedMs)
    return preflight
  }

  it('reports the readiness timeout with the inotify hint when subscribe never resolves', async () => {
    forkMock.mockImplementation(() => new StalledWatcherChild('none'))

    const error = await runPreflightFor(5_000)

    expect(error).toBeInstanceOf(Error)
    expect(error).toHaveProperty(
      'message',
      expect.stringMatching(
        /^Bundled file watcher readiness timed out; .*fs\.inotify\.max_user_instances.*\/etc\/sysctl\.d/
      )
    )
  })

  it('reports only the readiness timeout when subscribe resolved but ready never arrived', async () => {
    forkMock.mockImplementation(() => new StalledWatcherChild('subscribed'))

    const error = await runPreflightFor(5_000)

    expect(error).toBeInstanceOf(Error)
    expect(error).toHaveProperty('message', 'Bundled file watcher readiness timed out')
  })

  it('reports a watch error that settles after the readiness deadline instead of the timeout', async () => {
    forkMock.mockImplementation(() => new StalledWatcherChild('watch-error'))

    const error = await runPreflightFor(61_000)

    expect(error).toBeInstanceOf(Error)
    expect(error).toHaveProperty('message', 'inotify_init failed')
  })
})
