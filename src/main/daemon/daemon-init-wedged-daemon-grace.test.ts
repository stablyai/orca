import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WEDGED_DAEMON_GRACE_RETRIES } from './daemon-init'
import { FAKE_RUNTIME_DIR } from './daemon-init-test-harness'

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

vi.mock('electron', () => moduleFactories.electron())
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
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
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

  it('grace budget is generous enough to ride out a ~60s transient wedge', () => {
    // Why: each probe waits the client's 5s hello timeout, so 1 + 11 probes ≈ 60s of drain grace; don't cut without telemetry.
    expect(WEDGED_DAEMON_GRACE_RETRIES).toBeGreaterThanOrEqual(11)
  })

  it('preserves a daemon that stays wedged until the LAST allowed grace retry', async () => {
    // Why: daemon drains only on the last allowed probe (1 + WEDGED_DAEMON_GRACE_RETRIES) — must be preserved, not replaced.
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    let probe = 0
    const answeringDefault = function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: vi.fn(async () => ({ sessions: [] })),
        disconnect: vi.fn()
      }
    }
    daemonClientMock.mockImplementation(function MockDaemonClient() {
      probe += 1
      const drainsNow = probe >= 1 + WEDGED_DAEMON_GRACE_RETRIES
      return {
        ensureConnected: vi.fn(async () => {
          if (!drainsNow) {
            throw new Error('Hello response timed out')
          }
        }),
        request: vi.fn(async () => ({
          sessions: drainsNow ? [{ sessionId: 'wt-1@@live', isAlive: true }] : []
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

    try {
      await launcher('/fake/socket', '/fake/token')

      expect(killStaleDaemonMock).not.toHaveBeenCalled()
      expect(forkMock).not.toHaveBeenCalled()
    } finally {
      daemonClientMock.mockImplementation(answeringDefault)
    }
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
