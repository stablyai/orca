import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { fork, ChildProcess } from 'node:child_process'
import { HerdrDaemonSupervisor } from './herdr-daemon-supervisor'

class FakeChild extends EventEmitter {
  readonly pid = 4242
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  killed = false

  kill(signal?: NodeJS.Signals): boolean {
    this.killed = true
    this.signalCode = signal ?? 'SIGTERM'
    queueMicrotask(() => this.emit('exit', this.exitCode, this.signalCode))
    return true
  }
}

type SupervisorHarness = {
  supervisor: HerdrDaemonSupervisor
  children: FakeChild[]
  spawn: () => ChildProcess
  ping: () => Promise<void>
}

function makeHarness(options: {
  pingMode?: 'ok' | 'fail'
  pingCountBeforeOk?: number
  budgetMs?: number
  retryMs?: number
  maxRetryMs?: number
  livenessMs?: number
}): SupervisorHarness {
  const children: FakeChild[] = []
  let pings = 0
  const spawn = (): ChildProcess => {
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  }
  const ping = (): Promise<void> => {
    pings += 1
    const mode = options.pingMode ?? 'ok'
    if (mode === 'fail') {
      return Promise.reject(new Error('no listener'))
    }
    if (options.pingCountBeforeOk !== undefined && pings > options.pingCountBeforeOk) {
      return Promise.resolve()
    }
    return Promise.resolve()
  }
  const supervisor = new HerdrDaemonSupervisor({
    entryPath: '/tmp/fake-daemon-entry.js',
    runtimeDir: '/tmp',
    socketPath: '/tmp/fake-herdr-daemon.sock',
    spawn: spawn as unknown as typeof fork,
    pingSocket: ping,
    startBudgetMs: options.budgetMs ?? 40,
    retryIntervalMs: options.retryMs ?? 10,
    maxRetryIntervalMs: options.maxRetryMs ?? 500,
    livenessIntervalMs: options.livenessMs ?? 10
  })
  return { supervisor, children, spawn, ping }
}

describe('HerdrDaemonSupervisor', () => {
  it('reaches ready and resolves onceReady when the socket answers', async () => {
    const { supervisor, children } = makeHarness({})
    const ready = supervisor.onceReady()
    supervisor.start()
    await ready
    expect(supervisor.getStatus()).toBe('ready')
    expect(children).toHaveLength(1)
    await supervisor.stop()
    expect(supervisor.getStatus()).toBe('stopped')
    expect(children[0].killed).toBe(true)
  })

  it('flips to unavailable and retries when the socket never answers', async () => {
    const { supervisor, children } = makeHarness({ pingMode: 'fail' })
    supervisor.start()
    await vi.waitFor(() => {
      expect(supervisor.getStatus()).toBe('unavailable')
    })
    await vi.waitFor(() => {
      expect(children.length).toBeGreaterThanOrEqual(2)
    })
    await supervisor.stop()
  })

  it('backs off the restart interval as attempts grow', async () => {
    const { supervisor, children } = makeHarness({ pingMode: 'fail', budgetMs: 25 })
    supervisor.start()
    await vi.waitFor(() => {
      expect(supervisor.getStatus()).toBe('unavailable')
    })
    await vi.waitFor(() => {
      expect(children.length).toBeGreaterThanOrEqual(3)
    })
    expect(supervisor.retryAttempt).toBeGreaterThanOrEqual(2)
    await supervisor.stop()
  })

  it('recovers after a ready daemon exits', async () => {
    const { supervisor, children } = makeHarness({})
    supervisor.start()
    await vi.waitFor(() => {
      expect(supervisor.getStatus()).toBe('ready')
    })
    children[0].emit('exit', 1, null)
    await vi.waitFor(() => {
      expect(supervisor.getStatus()).toBe('ready')
    })
    expect(children.length).toBe(2)
    await supervisor.stop()
  })

  it('does not restart after stop', async () => {
    const { supervisor, children } = makeHarness({ pingMode: 'fail' })
    supervisor.start()
    await vi.waitFor(() => {
      expect(children.length).toBeGreaterThanOrEqual(1)
    })
    await supervisor.stop()
    const settled = children.length
    await vi.waitFor(() => {
      expect(supervisor.getStatus()).toBe('stopped')
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(children.length).toBe(settled)
  })
})
