import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WEDGED_DAEMON_GRACE_RETRIES } from './daemon-replacement-preflight'
import { FAKE_RUNTIME_DIR } from './daemon-init-test-harness'
import {
  DAEMON_RECOVERY_BUDGET_MS,
  DAEMON_RECOVERY_PROBE_MS,
  TRANSIENT_WEDGE_DRAIN_MS
} from './daemon-recovery-budget'
import { LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS } from '../startup/first-window-startup-services'

const {
  probeSocketExistsMock,
  netConnectMock,
  forkMock,
  checkDaemonHealthMock,
  killStaleDaemonMock,
  readLaunchedDaemonIdentity,
  daemonClientMock,
  spawnerInstances,
  importFresh,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

vi.mock('fs', () => moduleFactories.fs())
vi.mock('child_process', async (importOriginal) =>
  moduleFactories.childProcess(await importOriginal<Record<string, unknown>>())
)
vi.mock('net', () => moduleFactories.net())
vi.mock('./daemon-health', () => moduleFactories.daemonHealth())
vi.mock('./daemon-pid-identity', () => moduleFactories.daemonPidIdentity())
vi.mock('./daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('./daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('./daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('./daemon-process-start-time', () => moduleFactories.daemonProcessStartTime())
vi.mock('./daemon-pid-file-parse', () => moduleFactories.daemonPidFileParse())
vi.mock('./client', () => moduleFactories.client())
vi.mock('./daemon-lifecycle-event', () => moduleFactories.daemonLifecycleEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty/provider/registry', () => moduleFactories.ptyProviderRegistry())
vi.mock('../ipc/pty/provider/listener-lifecycle', () => moduleFactories.ptyListenerLifecycle())

describe('daemon-init: runRestartDaemon (7-step sequence)', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  function stubAliveSocketConnect() {
    const handlers: Record<string, (() => void)[]> = { connect: [], error: [] }
    return {
      on(event: string, cb: () => void) {
        handlers[event]?.push(cb)
        if (event === 'connect') {
          queueMicrotask(() => cb())
        }
        return this
      },
      removeListener(event: string, cb: () => void) {
        handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
        return this
      },
      destroy() {}
    }
  }

  // Charge simulated stalled probes the production client timeout budgets.
  const CLIENT_CONNECT_TIMEOUT_MS = 5_000
  const CLIENT_REQUEST_TIMEOUT_MS = 30_000
  const HEALTH_CHECK_TIMEOUT_MS = 3_000
  // Reserve post-recovery time for identity checks, signals, endpoint probing, fork, lease and adapter connection.
  const POST_RECOVERY_KILL_MS = 3_000 + 3_000 + 3_000 + 1_000 + 500
  const POST_RECOVERY_FORK_MS = 10_000
  const POST_RECOVERY_LEASE_MS = 5_000
  const POST_RECOVERY_RELAUNCH_MS =
    POST_RECOVERY_KILL_MS + POST_RECOVERY_FORK_MS + POST_RECOVERY_LEASE_MS

  /** Advance by production timeout budgets, stopping at recovery so the in-flight probe can answer. */
  async function runWedgedRecovery(
    wedgeAt: 'handshake' | 'listSessions',
    drainsAfterMs = Number.POSITIVE_INFINITY
  ): Promise<number> {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const startedAtMs = 1_700_000_000_000
    const drainsAtMs = startedAtMs + drainsAfterMs
    const clock = { now: startedAtMs }
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    const wedge = { active: true, drained: false }

    const stall = async (timeoutMs: number, message: string): Promise<void> => {
      if (drainsAtMs > clock.now + timeoutMs) {
        clock.now += timeoutMs
        throw new Error(message)
      }
      clock.now = Math.max(clock.now, drainsAtMs)
      wedge.active = false
      wedge.drained = true
    }
    daemonClientMock.mockImplementation(function MockDaemonClient() {
      const connect = async (timeoutMs = CLIENT_CONNECT_TIMEOUT_MS): Promise<void> => {
        if (wedge.active && wedgeAt === 'handshake') {
          await stall(timeoutMs, 'Hello response timed out')
        }
      }
      return {
        ensureConnected: vi.fn(() => connect()),
        ensureConnectedWithin: vi.fn(connect),
        getDaemonIdentity: vi.fn(readLaunchedDaemonIdentity),
        request: vi.fn(async (_type: string, _payload: unknown, timeoutMs?: number) => {
          if (wedge.active && wedgeAt === 'listSessions') {
            await stall(timeoutMs ?? CLIENT_REQUEST_TIMEOUT_MS, 'Request timed out')
          }
          return { sessions: wedge.drained ? [{ sessionId: 'wt-1@@live', isAlive: true }] : [] }
        }),
        disconnect: vi.fn()
      }
    })
    checkDaemonHealthMock.mockImplementationOnce(async () => {
      clock.now += HEALTH_CHECK_TIMEOUT_MS
      return 'unreachable'
    })
    // End the simulated wedge at replacement so the new daemon can answer its adoption lease.
    killStaleDaemonMock.mockImplementationOnce(async () => {
      wedge.active = false
      return { killed: true, liveOwnerSurvived: false }
    })
    probeSocketExistsMock.mockReturnValue(true)
    netConnectMock.mockImplementation(stubAliveSocketConnect)
    forkMock.mockImplementationOnce(() => ({
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', pid: 12345, startedAtMs: 1_000_000 }))
        }
        return this
      },
      off() {
        return this
      },
      disconnect: vi.fn(),
      unref: vi.fn()
    }))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    try {
      await launcher('/fake/socket', '/fake/token')
    } finally {
      warnSpy.mockRestore()
      nowSpy.mockRestore()
      daemonClientMock.mockImplementation(function MockDaemonClient() {
        return {
          ensureConnected: vi.fn(async () => {}),
          ensureConnectedWithin: vi.fn(async () => {}),
          request: vi.fn(async () => ({ sessions: [] })),
          disconnect: vi.fn()
        }
      })
    }
    return clock.now - startedAtMs
  }

  it('adopts a transiently wedged daemon that drains and reports live sessions within the grace window', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // Time out once while draining, then return a live session on the retry.
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {
          throw new Error('Hello response timed out')
        }),
        ensureConnectedWithin: vi.fn(async () => {
          throw new Error('Hello response timed out')
        }),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        ensureConnectedWithin: vi.fn(async () => {}),
        request: vi.fn(async () => ({
          sessions: [{ sessionId: 'wt-1@@live', isAlive: true }]
        })),
        disconnect: vi.fn()
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')
    probeSocketExistsMock.mockReturnValue(true)
    netConnectMock.mockImplementation(stubAliveSocketConnect)

    await launcher('/fake/socket', '/fake/token')

    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('replaces a permanently wedged daemon after the grace window is exhausted (#8689)', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const answeringDefault = function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        ensureConnectedWithin: vi.fn(async () => {}),
        request: vi.fn(async () => ({ sessions: [] })),
        disconnect: vi.fn()
      }
    }
    // Keep old-daemon probes wedged while allowing the replacement's adoption lease.
    let daemonClientConstructionCount = 0
    daemonClientMock.mockImplementation(function MockDaemonClient() {
      daemonClientConstructionCount++
      return {
        ensureConnected: vi.fn(async () => {
          if (daemonClientConstructionCount <= 2 + WEDGED_DAEMON_GRACE_RETRIES) {
            throw new Error('Hello response timed out')
          }
        }),
        ensureConnectedWithin: vi.fn(async () => {
          if (daemonClientConstructionCount <= 2 + WEDGED_DAEMON_GRACE_RETRIES) {
            throw new Error('Hello response timed out')
          }
        }),
        getDaemonIdentity: vi.fn(readLaunchedDaemonIdentity),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')
    probeSocketExistsMock.mockReturnValue(true)
    netConnectMock.mockImplementation(stubAliveSocketConnect)
    forkMock.mockImplementationOnce(() => ({
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', pid: 12345, startedAtMs: 1_000_000 }))
        }
        return this
      },
      off() {
        return this
      },
      disconnect: vi.fn(),
      unref: vi.fn()
    }))

    daemonClientMock.mockClear()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await launcher('/fake/socket', '/fake/token')

      expect(killStaleDaemonMock).toHaveBeenCalledWith(
        FAKE_RUNTIME_DIR,
        '/fake/socket',
        '/fake/token'
      )
      expect(forkMock).toHaveBeenCalled()
      expect(daemonClientMock).toHaveBeenCalledTimes(3 + WEDGED_DAEMON_GRACE_RETRIES)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Replacing daemon that failed the health check')
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`graceRetries=${WEDGED_DAEMON_GRACE_RETRIES}`)
      )
    } finally {
      warnSpy.mockRestore()
      // mockClear preserves implementations; restore the answering default for later tests.
      daemonClientMock.mockImplementation(answeringDefault)
    }
  })

  it('bounds recovery inside the startup PTY gate without cutting into the drain grace', () => {
    // Preserve the documented transient-drain window before permitting replacement.
    expect(DAEMON_RECOVERY_BUDGET_MS).toBeGreaterThan(TRANSIENT_WEDGE_DRAIN_MS)
    // Recovery and the subsequent kill/relaunch share the startup gate's cap.
    expect(DAEMON_RECOVERY_BUDGET_MS + POST_RECOVERY_RELAUNCH_MS).toBeLessThan(
      LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS
    )
    // A second opinion needs a longer budget than the health check it re-evaluates.
    expect(DAEMON_RECOVERY_PROBE_MS).toBeGreaterThan(HEALTH_CHECK_TIMEOUT_MS)
    // Retry count limits instant failures; elapsed time must bound stalled probes first.
    expect(WEDGED_DAEMON_GRACE_RETRIES * DAEMON_RECOVERY_PROBE_MS).toBeGreaterThan(
      DAEMON_RECOVERY_BUDGET_MS
    )
  })

  it('preserves a daemon that drains on the last probe the recovery budget allows', async () => {
    // Advance a simulated clock so the time budget, rather than instant mocked retries, determines the last probe.
    const recoveryMs = await runWedgedRecovery('handshake', DAEMON_RECOVERY_BUDGET_MS - 1_000)

    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
    expect(recoveryMs).toBeLessThanOrEqual(DAEMON_RECOVERY_BUDGET_MS)
  })

  it('ends the grace on the recovery budget when every handshake stalls', async () => {
    expect(await runWedgedRecovery('handshake')).toBeLessThanOrEqual(DAEMON_RECOVERY_BUDGET_MS)
    expect(killStaleDaemonMock).toHaveBeenCalled()
  })

  it('ends the grace on the recovery budget when the daemon answers hello and then wedges', async () => {
    expect(await runWedgedRecovery('listSessions')).toBeLessThanOrEqual(DAEMON_RECOVERY_BUDGET_MS)
    expect(killStaleDaemonMock).toHaveBeenCalled()
  })

  it('still adopts a wedge that drains at the far edge of the documented window (#8697)', async () => {
    const recoveryMs = await runWedgedRecovery('handshake', TRANSIENT_WEDGE_DRAIN_MS)

    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
    expect(recoveryMs).toBeGreaterThanOrEqual(TRANSIENT_WEDGE_DRAIN_MS)
  })

  it('replaces a wedge that drains after the recovery budget (accepted trade vs #8697)', async () => {
    // Daemons draining after the bounded grace are replaced, losing live sessions; the window is tunable.
    await runWedgedRecovery('handshake', DAEMON_RECOVERY_BUDGET_MS + 5_000)

    expect(killStaleDaemonMock).toHaveBeenCalled()
  })

  it('replaces a hello-rejected daemon even though its pipe accepts connections', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {
          throw new Error('Hello rejected')
        }),
        ensureConnectedWithin: vi.fn(async () => {
          throw new Error('Hello rejected')
        }),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('rejected')
    probeSocketExistsMock.mockReturnValue(true)
    netConnectMock.mockImplementation(stubAliveSocketConnect)
    forkMock.mockImplementationOnce(() => ({
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', pid: 12345, startedAtMs: 1_000_000 }))
        }
        return this
      },
      off() {
        return this
      },
      disconnect: vi.fn(),
      unref: vi.fn()
    }))
    daemonClientMock.mockClear()

    await launcher('/fake/socket', '/fake/token')

    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalled()
    expect(daemonClientMock).toHaveBeenCalledTimes(3)
  })
})
