import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKE_RUNTIME_DIR } from './daemon-init-test-harness'
import { DAEMON_RECOVERY_BUDGET_MS } from '../../../launch/daemon-recovery-budget'

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
vi.mock('../../../health/daemon-health', () => moduleFactories.daemonHealth())
vi.mock('../../../endpoint/identity/daemon-pid-identity', () => moduleFactories.daemonPidIdentity())
vi.mock('../../../permissions/daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('../../../launch/daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('../../../launch/daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('../../../endpoint/identity/daemon-process-start-time', () =>
  moduleFactories.daemonProcessStartTime()
)
vi.mock('../../../endpoint/identity/daemon-pid-file-parse', () =>
  moduleFactories.daemonPidFileParse()
)
vi.mock('../../../transport/client/daemon-client', () => moduleFactories.client())
vi.mock('../../../observability/daemon-lifecycle-event', () =>
  moduleFactories.daemonLifecycleEvent()
)
vi.mock('../../../launch/daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('../../adapter/daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../../../../ipc/pty/provider/registry', () => moduleFactories.ptyProviderRegistry())
vi.mock('../../../../ipc/pty/provider/listener-lifecycle', () =>
  moduleFactories.ptyListenerLifecycle()
)

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
