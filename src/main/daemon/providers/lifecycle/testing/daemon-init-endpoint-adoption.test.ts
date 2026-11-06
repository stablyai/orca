import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DAEMON_RECOVERY_BUDGET_MS } from '../../../launch/daemon-recovery-budget'

const {
  isPackagedMock,
  readFileSyncMock,
  forkMock,
  checkDaemonHealthMock,
  getMacDaemonTccAttributionHealthMock,
  getDaemonLaunchIdentityMock,
  killStaleDaemonMock,
  replaceDaemonPidFileMock,
  daemonClientMock,
  netConnectMock,
  probeSocketExistsMock,
  spawnerInstances,
  trackDaemonReplacedMock,
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

  it('adopts the winner when a launched daemon loses the endpoint race', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider(undefined, { macosLoginSessionWatch: true })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    // Force launch so occupied-exit adoption is actually exercised.
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 24680,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          // Carry occupied status on exit; an IPC-only notification can race launcher settlement.
          if (event === 'exit') {
            queueMicrotask(() => cb(20))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        kill: vi.fn(),
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await expect(launcher('/fake/socket', '/fake/token')).resolves.toMatchObject({
      shutdown: expect.any(Function)
    })
    expect(forkMock).toHaveBeenCalledTimes(1)
  })

  it('preserves a severed-attribution daemon that owns live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider(undefined, { macosLoginSessionWatch: true })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getMacDaemonTccAttributionHealthMock.mockResolvedValueOnce('severed')
    daemonClientMock.mockImplementation(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        ensureConnectedWithin: vi.fn(async () => {}),
        request: vi.fn(async () => ({ sessions: [{ sessionId: 's1', isAlive: true }] })),
        disconnect: vi.fn()
      }
    })

    const handle = await launcher('/fake/socket', '/fake/token')

    expect(handle).toBeDefined()
    expect(forkMock).not.toHaveBeenCalled()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(trackDaemonReplacedMock).not.toHaveBeenCalled()
  })

  it('adopts the authenticated endpoint even when the PID record cannot be repaired', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const endpointIdentity = {
      pid: 101,
      startedAtMs: 1_000_000,
      launchNonce: 'socket-owner'
    }
    daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        ensureConnectedWithin: vi.fn(async () => {}),
        getDaemonIdentity: vi.fn(() => endpointIdentity),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
    readFileSyncMock.mockReturnValueOnce(
      JSON.stringify({
        pid: 202,
        startedAtMs: 2_000_000,
        launchNonce: 'stale-owner'
      })
    )
    replaceDaemonPidFileMock.mockReturnValueOnce(false)
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ releaseAdoptionLease?(): void; shutdown(): Promise<void> }>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const forkCallsBefore = forkMock.mock.calls.length

    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'unused')

      expect(handle).toBeDefined()
      expect(forkMock.mock.calls.length).toBe(forkCallsBefore)
      expect(warn).toHaveBeenCalledWith(
        '[daemon] Could not repair daemon PID ownership; adopting the authenticated endpoint anyway'
      )
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('degrades instead of forking beside a daemon that could not be confirmed stopped', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()
    const forkCallsBefore = forkMock.mock.calls.length
    // Adopt a surviving endpoint owner in degraded mode so its sessions remain reachable.
    killStaleDaemonMock.mockResolvedValueOnce({
      killed: false,
      liveOwnerSurvived: true
    })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ mode?: string; releaseAdoptionLease?(): void }>
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'launch-new')

      expect(handle.mode).toBe('degraded-new-pty-fallback')
      expect(forkMock.mock.calls.length).toBe(forkCallsBefore)
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
    }
  })

  it('rescues the endpoint owner with a full probe window after the recovery budget is spent', async () => {
    // Rescue runs after recovery expires; a remaining-budget probe would time out before a live daemon answers.
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()
    const clock = { now: 1_700_000_000_000 }
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock.now)
    // Simulate the kill completing after the recovery deadline.
    killStaleDaemonMock.mockImplementationOnce(async () => {
      clock.now += DAEMON_RECOVERY_BUDGET_MS + 5_000
      return { killed: true, liveOwnerSurvived: false }
    })
    function basicClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        ensureConnectedWithin: vi.fn(async () => {}),
        request: vi.fn(async () => ({ sessions: [] })),
        disconnect: vi.fn()
      }
    }
    daemonClientMock.mockImplementationOnce(basicClient)
    daemonClientMock.mockImplementationOnce(basicClient)
    daemonClientMock.mockImplementationOnce(function MockPostReadyClient() {
      return {
        ...basicClient(),
        getDaemonIdentity: vi.fn(() => ({
          pid: 999,
          startedAtMs: 900_000,
          launchNonce: 'stale-launch'
        }))
      }
    })
    const exitHandlers: ((code?: unknown) => void)[] = []
    const child = {
      pid: 12345,
      connected: true,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      on(event: string, callback: (arg?: unknown) => void) {
        if (event === 'exit') {
          exitHandlers.push(callback)
        }
        if (event === 'message') {
          queueMicrotask(() => callback({ type: 'ready', pid: 12345, startedAtMs: 1_000_000 }))
        }
        return this
      },
      once(event: string, callback: (arg?: unknown) => void) {
        return child.on(event, callback)
      },
      off() {
        return child
      },
      kill: vi.fn(() => true),
      disconnect: vi.fn(() => {
        child.connected = false
      }),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      queueMicrotask(() => {
        child.exitCode = 0
        for (const callback of exitHandlers.slice()) {
          callback(0)
        }
      })
      return true
    })
    probeSocketExistsMock.mockReturnValue(true)
    // A loaded host answers late but well inside probeDaemonSocket's own 1s default.
    netConnectMock.mockImplementation(() => ({
      on(event: string, callback: () => void) {
        if (event === 'connect') {
          setTimeout(callback, 500)
        }
        return this
      },
      removeListener() {
        return this
      },
      destroy() {}
    }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ mode?: string; releaseAdoptionLease?(): void }>

    try {
      const handle = await launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'launch-new')

      expect(handle.mode).toBe('degraded-new-pty-fallback')
      handle.releaseAdoptionLease?.()
    } finally {
      warn.mockRestore()
      kill.mockRestore()
      nowSpy.mockRestore()
      probeSocketExistsMock.mockReturnValue(false)
    }
  })

  it('adopts a healthy daemon whose pid-file identity cannot be verified (null startedAtMs metadata)', async () => {
    // Legacy Windows PID records lack start times; healthy endpoints remain adoptable.
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockReturnValueOnce('unknown')
    isPackagedMock.mockReturnValue(true)

    await launcher('/fake/socket', '/fake/token')

    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })
})
