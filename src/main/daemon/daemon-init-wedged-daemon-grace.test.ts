import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WEDGED_DAEMON_GRACE_RETRIES } from './daemon-init'
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
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())

describe('daemon-init: runRestartDaemon (7-step sequence)', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // Why: net.connect stub whose 'connect' fires, so probeSocket() reports the pipe alive on every grace re-check.
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

  // The real client's own defaults, which is what an unbudgeted probe pays. Mirrored here so the
  // simulated clock below charges a wedge exactly what production would have spent on it.
  const CLIENT_CONNECT_TIMEOUT_MS = 5_000
  const CLIENT_REQUEST_TIMEOUT_MS = 30_000
  const HEALTH_CHECK_TIMEOUT_MS = 3_000
  // What still has to fit inside the startup PTY gate once recovery decides, at each stage's own
  // hard cap: killStaleDaemon's two identity inspections, SIGTERM wait, SIGKILL confirm and
  // endpoint probe (daemon-stale-kill.ts, daemon-process-identity-query.ts,
  // daemon-endpoint-probe.ts), then launchDaemonChild's readiness timeout
  // (daemon-launched-child.ts), then the adoption lease and adapter connects — the last against a
  // daemon that just reported ready, so an allowance rather than the client's unbudgeted 4x5s.
  const POST_RECOVERY_KILL_MS = 3_000 + 3_000 + 3_000 + 1_000 + 500
  const POST_RECOVERY_FORK_MS = 10_000
  const POST_RECOVERY_LEASE_MS = 5_000
  const POST_RECOVERY_RELAUNCH_MS =
    POST_RECOVERY_KILL_MS + POST_RECOVERY_FORK_MS + POST_RECOVERY_LEASE_MS

  /**
   * Runs the launcher against a daemon that accepts connections and answers nothing until
   * `drainsAfterMs` of simulated elapsed time, on a hand-driven clock: each mocked wait advances
   * Date.now by exactly what the real call would have blocked for, or stops at the drain — the
   * probe already in flight when the daemon comes back is the one that gets an answer. Returns
   * how long the adopt-or-replace decision took.
   */
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
          // A daemon that drained still owns the sessions this grace exists to preserve.
          return { sessions: wedge.drained ? [{ sessionId: 'wt-1@@live', isAlive: true }] : [] }
        }),
        disconnect: vi.fn()
      }
    })
    checkDaemonHealthMock.mockImplementationOnce(async () => {
      clock.now += HEALTH_CHECK_TIMEOUT_MS
      return 'unreachable'
    })
    // Ending the wedge on the kill keeps the replacement daemon answering its adoption lease.
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
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
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
    // Nothing after the adopt-or-replace decision advances the simulated clock, so this is it.
    return clock.now - startedAtMs
  }

  it('adopts a transiently wedged daemon that drains and reports live sessions within the grace window', async () => {
    // Why: Windows update-relaunch — post-install load wedges the daemon briefly; it still owns live sessions, so grace-adopt not kill.
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // First probe times out (still draining); the retry within grace succeeds with a live session.
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
    // Why: a socket that accepts connections but never answers hello was preserved forever (#8689); after grace it must be replaced.
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
    // Permanent wedge: every probe times out, then the freshly spawned daemon accepts the temporary adoption lease.
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
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      off() {
        return this
      },
      disconnect: vi.fn(),
      unref: vi.fn()
    }))

    // Count only the launcher's own session-count probes.
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
      // The launcher probes the full grace budget: 1 initial probe + WEDGED_DAEMON_GRACE_RETRIES retries.
      expect(daemonClientMock).toHaveBeenCalledTimes(3 + WEDGED_DAEMON_GRACE_RETRIES)
      // Why: this replace path used to kill the daemon with no log, so a post-hoc
      // reader could not tell it apart from an adoption; the verdict must be recorded.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Replacing daemon that failed the health check')
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`graceRetries=${WEDGED_DAEMON_GRACE_RETRIES}`)
      )
    } finally {
      warnSpy.mockRestore()
      // Restore the answering default: clearAllMocks clears calls not impls, so the throwing impl would leak into later tests.
      daemonClientMock.mockImplementation(answeringDefault)
    }
  })

  it('bounds recovery inside the startup PTY gate without cutting into the drain grace', () => {
    // Lower bound: #8697 bought adoption of a daemon that drains within ~20s *with* its live
    // sessions; a budget that expires first turns that adoption back into a kill.
    expect(DAEMON_RECOVERY_BUDGET_MS).toBeGreaterThan(TRANSIENT_WEDGE_DRAIN_MS)
    // Upper bound: recovery is only the first phase inside the gate's fail-open cap — the kill
    // and the relaunch that follow it run inside the same cap.
    expect(DAEMON_RECOVERY_BUDGET_MS + POST_RECOVERY_RELAUNCH_MS).toBeLessThan(
      LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS
    )
    // Why the probe outruns the health check: it is the second opinion on that check's verdict,
    // so on the loaded machine it exists for, the same bar would just reproduce it.
    expect(DAEMON_RECOVERY_PROBE_MS).toBeGreaterThan(HEALTH_CHECK_TIMEOUT_MS)
    // Why: the count is a spin guard for instantly-failing probes only. If it could bind first, a
    // wedge would again be graced for however long its probes happened to take.
    expect(WEDGED_DAEMON_GRACE_RETRIES * DAEMON_RECOVERY_PROBE_MS).toBeGreaterThan(
      DAEMON_RECOVERY_BUDGET_MS
    )
  })

  it('preserves a daemon that drains on the last probe the recovery budget allows', async () => {
    // Why rewritten onto the clock: this used to drain on probe 1 + WEDGED_DAEMON_GRACE_RETRIES
    // with real Date.now, so its 12 probes elapsed ~0ms and the budget never bound — a grace
    // production can no longer deliver, since each failing probe costs up to
    // DAEMON_RECOVERY_PROBE_MS. The count's exhaustion side stays pinned by the #8689 test above.
    const recoveryMs = await runWedgedRecovery('handshake', DAEMON_RECOVERY_BUDGET_MS - 1_000)

    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
    expect(recoveryMs).toBeLessThanOrEqual(DAEMON_RECOVERY_BUDGET_MS)
  })

  it('ends the grace on the recovery budget when every handshake stalls', async () => {
    // Why: unbudgeted, this cost the client's 5s connect default once per probe across 12 probes
    // — ~68s with the health check, past the gate's 60s fail-open cap (STA-5732).
    expect(await runWedgedRecovery('handshake')).toBeLessThanOrEqual(DAEMON_RECOVERY_BUDGET_MS)
    expect(killStaleDaemonMock).toHaveBeenCalled()
  })

  it('ends the grace on the recovery budget when the daemon answers hello and then wedges', async () => {
    // Why: this is the shape the ticket reported — listSessions fell back to the client's 30s
    // request default, so 12 probes stalled startup for minutes.
    expect(await runWedgedRecovery('listSessions')).toBeLessThanOrEqual(DAEMON_RECOVERY_BUDGET_MS)
    expect(killStaleDaemonMock).toHaveBeenCalled()
  })

  it('still adopts a wedge that drains at the far edge of the documented window (#8697)', async () => {
    // Why: the wall clock now ends the grace, so the budget is the only thing keeping the
    // Windows update-relaunch wedge adoptable. It comes back owning live sessions well after the
    // probes start failing; recovery has to still be probing then instead of having killed it.
    const recoveryMs = await runWedgedRecovery('handshake', TRANSIENT_WEDGE_DRAIN_MS)

    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
    expect(recoveryMs).toBeGreaterThanOrEqual(TRANSIENT_WEDGE_DRAIN_MS)
  })

  it('replaces a wedge that drains after the recovery budget (accepted trade vs #8697)', async () => {
    // Why pinned rather than left implicit: #8697's merged grace was 11 retries ~= 60s, chosen to
    // keep live-session loss near zero. Bounding it at DAEMON_RECOVERY_BUDGET_MS is a deliberate
    // narrowing — a Windows update-relaunch wedge that drains after the budget is now replaced and
    // its live terminal/agent sessions are destroyed. Only the window size is tunable.
    await runWedgedRecovery('handshake', DAEMON_RECOVERY_BUDGET_MS + 5_000)

    expect(killStaleDaemonMock).toHaveBeenCalled()
  })

  it('replaces a hello-rejected daemon even though its pipe accepts connections', async () => {
    // Why: 'rejected' = daemon refused the handshake; it can never be adopted, so replacement is the only recovery.
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
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
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
    // 'rejected' gets no grace window (probed once): count = initial adoption + rejected probe + fresh daemon lease.
    expect(daemonClientMock).toHaveBeenCalledTimes(3)
  })
})
