import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from './daemon-endpoint-ownership'
import { launchDaemonChild } from './daemon-launched-child'
import type { DaemonChildSpawnOptions } from './daemon-launched-child-spawn'

const { spawnDaemonChildProcessMock, isDurableDaemonScopeSupportedMock } = vi.hoisted(() => ({
  spawnDaemonChildProcessMock: vi.fn(),
  isDurableDaemonScopeSupportedMock: vi.fn(() => false)
}))

vi.mock('./daemon-launched-child-spawn', () => ({
  spawnDaemonChildProcess: spawnDaemonChildProcessMock
}))
vi.mock('./daemon-cgroup-scope', () => ({
  isDurableDaemonScopeSupported: isDurableDaemonScopeSupportedMock
}))
vi.mock('./daemon-spawner', () => ({ unlinkOwnedDaemonPidFile: vi.fn(() => true) }))

// exitCode is writable here: the launcher reads it to decide whether the child is already gone.
type FakeDaemonChild = Omit<ChildProcess, 'exitCode'> & {
  exitCode: number | null
  disconnect: Mock
  unref: Mock
}

const LAUNCH_OPTIONS: DaemonChildSpawnOptions = {
  entryPath: '/fake/app/out/main/daemon-entry.js',
  forkEntryPath: '/fake/app/out/main/daemon-entry.js',
  userDataPath: '/fake/userData',
  socketPath: '/fake/socket',
  tokenPath: '/fake/token',
  pidPath: '/fake/daemon.pid',
  launchNonce: 'nonce-a',
  macosLoginSessionWatch: false
}

function fakeDaemonChild(pid: number): FakeDaemonChild {
  const child = new EventEmitter() as unknown as FakeDaemonChild
  return Object.assign(child, {
    pid,
    disconnect: vi.fn(),
    unref: vi.fn(),
    exitCode: null,
    signalCode: null
  })
}

afterEach(() => {
  vi.clearAllMocks()
  spawnDaemonChildProcessMock.mockReset()
  isDurableDaemonScopeSupportedMock.mockReturnValue(false)
})

describe('launchDaemonChild identity', () => {
  it('takes the PID the daemon reports for itself, not the immediate child PID', async () => {
    // The immediate child of a durable-scope launch is `systemd-run`, so its PID is only ever
    // the daemon's by way of systemd-run's exec. The identity must not depend on that.
    isDurableDaemonScopeSupportedMock.mockReturnValue(true)
    const child = fakeDaemonChild(4242)
    spawnDaemonChildProcessMock.mockReturnValue(child)

    const launch = launchDaemonChild(LAUNCH_OPTIONS)
    child.emit('message', {
      type: 'ready',
      pid: 9999,
      startedAtMs: 1_700_000_000_000,
      linuxStartTicks: '5150',
      bootId: 'boot-a'
    })
    const launched = await launch

    expect(spawnDaemonChildProcessMock).toHaveBeenCalledWith(LAUNCH_OPTIONS, true)
    expect(launched.identity).toEqual({
      pid: 9999,
      startedAtMs: 1_700_000_000_000,
      linuxStartTicks: '5150',
      bootId: 'boot-a',
      launchNonce: 'nonce-a'
    })
  })

  it('rejects a readiness message that carries no self-reported PID', async () => {
    const child = fakeDaemonChild(4242)
    spawnDaemonChildProcessMock.mockReturnValue(child)
    // The startup-failure path signals the child; keep that off any real PID.
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('already exited'), { code: 'ESRCH' })
    })

    try {
      const launch = launchDaemonChild(LAUNCH_OPTIONS)
      child.emit('message', { type: 'ready', startedAtMs: 1_700_000_000_000 })

      await expect(launch).rejects.toThrow('Daemon readiness identity is incomplete')
      expect(kill).toHaveBeenCalledWith(4242, 'SIGTERM')
      expect(child.disconnect).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
    }
  })
})

describe('launchDaemonChild durable-scope fallback', () => {
  it('retries once without cgroup isolation when the scoped attempt fails', async () => {
    isDurableDaemonScopeSupportedMock.mockReturnValue(true)
    const scoped = fakeDaemonChild(4242)
    const unscoped = fakeDaemonChild(4343)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    spawnDaemonChildProcessMock.mockImplementation((_options, useDurableScope: boolean) => {
      if (useDurableScope) {
        // Whatever the pre-flight probe promised, the real StartTransientUnit call can still fail.
        queueMicrotask(() => {
          scoped.exitCode = 1
          scoped.emit('exit', 1)
        })
        return scoped
      }
      queueMicrotask(() =>
        unscoped.emit('message', { type: 'ready', pid: 4343, startedAtMs: 1_000_000 })
      )
      return unscoped
    })

    try {
      const launched = await launchDaemonChild(LAUNCH_OPTIONS)

      expect(spawnDaemonChildProcessMock.mock.calls.map(([, scope]) => scope)).toEqual([
        true,
        false
      ])
      expect(launched.identity.pid).toBe(4343)
    } finally {
      warn.mockRestore()
    }
  })

  it('does not retry when another daemon already owns the endpoint', async () => {
    // A lost endpoint race is not a scope failure: the caller adopts the winner, and a second
    // child would only lose the same race.
    isDurableDaemonScopeSupportedMock.mockReturnValue(true)
    const scoped = fakeDaemonChild(4242)
    spawnDaemonChildProcessMock.mockImplementation(() => {
      queueMicrotask(() => {
        scoped.exitCode = DAEMON_EXIT_ENDPOINT_OCCUPIED
        scoped.emit('exit', DAEMON_EXIT_ENDPOINT_OCCUPIED)
      })
      return scoped
    })

    await expect(launchDaemonChild(LAUNCH_OPTIONS)).rejects.toThrow(
      'Daemon could not take the endpoint: occupied'
    )
    expect(spawnDaemonChildProcessMock).toHaveBeenCalledOnce()
  })
})
