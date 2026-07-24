/* eslint-disable max-lines -- Why: covers daemon-init's full restart flow (7-step sequence per docs/daemon-staleness-ux.md §Phase 1 + coalescer); one describe block keeps shared mocks in one place. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from './types'
import { WEDGED_DAEMON_GRACE_RETRIES } from './daemon-init'

const FAKE_USER_DATA_PATH = '/fake/userData'
const FAKE_RUNTIME_DIR = join(FAKE_USER_DATA_PATH, 'daemon')
const FAKE_APP_PATH = '/fake/app'
const FAKE_APP_OUT_MAIN_PATH = join(FAKE_APP_PATH, 'out', 'main')
const FAKE_DAEMON_ENTRY_PATH = join(FAKE_APP_OUT_MAIN_PATH, 'daemon-entry.js')

// Why: we only care about runRestartDaemon's observable sequencing/identity invariants, so every non-daemon-init dependency is a minimal stub.
const {
  getPathMock,
  getAppPathMock,
  isPackagedMock,
  probeSocketExistsMock,
  writeFileSyncMock,
  readFileSyncMock,
  unlinkSyncMock,
  netConnectMock,
  forkMock,
  checkDaemonHealthMock,
  healthCheckDaemonMock,
  getMacDaemonSystemResolverHealthMock,
  getDaemonLaunchIdentityMock,
  isDaemonStaleForCurrentBundleMock,
  killStaleDaemonMock,
  getProcessStartedAtMsMock,
  parseDaemonPidFileMock,
  unlinkOwnedDaemonPidFileMock,
  daemonClientMock,
  spawnerInstances,
  ensureRunningOverrides,
  adoptionLeaseReleases,
  lifecycleLeaseErrors,
  disconnectOnlyErrors,
  routerSubscriptionError,
  adapterInstances,
  defaultListSessionsSessions,
  listProcessesControl,
  getLocalPtyProviderMock,
  localFallbackProvider,
  setLocalPtyProviderMock,
  unbindLocalProviderListenersMock,
  rebindLocalProviderListenersMock
} = vi.hoisted(() => {
  const getPathMock = vi.fn(() => '/fake/userData')
  const getAppPathMock = vi.fn(() => '/fake/app')
  const isPackagedMock = vi.fn(() => false)

  const probeSocketExistsMock = vi.fn((_path?: string) => false)
  const writeFileSyncMock = vi.fn()
  // Why: readFileSync throws by default so legacyDaemonProcessMayBeAlive treats every legacy pid file as unreadable (pre-fix cleanup behavior).
  const readFileSyncMock = vi.fn((): string => {
    throw new Error('ENOENT')
  })
  const unlinkSyncMock = vi.fn()
  const forkMock = vi.fn()
  const netConnectMock = vi.fn(() => {
    // Why: stub the socket so probeSocket's 'error' path fires and cleanupDaemonForProtocol's alive=false branch runs without side effects.
    const handlers: Record<string, (() => void)[]> = { connect: [], error: [] }
    return {
      on(event: string, cb: () => void) {
        handlers[event]?.push(cb)
        if (event === 'error') {
          // Fire after microtask so destroy()/resolve ordering matches real net
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
  })

  const checkDaemonHealthMock = vi.fn(async () => 'healthy')
  const healthCheckDaemonMock = vi.fn(async () => true)
  const getMacDaemonSystemResolverHealthMock = vi.fn(() => 'healthy')
  const getDaemonLaunchIdentityMock = vi.fn(() => 'match')
  const isDaemonStaleForCurrentBundleMock = vi.fn(() => false)
  const killStaleDaemonMock = vi.fn(async () => true)
  const getProcessStartedAtMsMock = vi.fn((): number | null => 1_000_000)
  const parseDaemonPidFileMock = vi.fn(
    (): { pid: number; startedAtMs: number | null } | null => null
  )
  const unlinkOwnedDaemonPidFileMock = vi.fn(() => true)

  const daemonClientMock = vi.fn().mockImplementation(function MockDaemonClient() {
    return {
      ensureConnected: vi.fn(async () => {}),
      request: vi.fn(async () => ({ sessions: [] })),
      disconnect: vi.fn()
    }
  })

  // Why: every DaemonSpawner pushes here so assertions can check the *same* spawner was reused across restart.
  const spawnerInstances: MockSpawner[] = []
  const ensureRunningOverrides: (() => Promise<{
    socketPath: string
    tokenPath: string
    mode?: 'degraded-new-pty-fallback'
  }>)[] = []
  const adoptionLeaseReleases: ReturnType<typeof vi.fn>[] = []
  const lifecycleLeaseErrors: Error[] = []
  const disconnectOnlyErrors: Error[] = []
  const routerSubscriptionError: { current: Error | null } = { current: null }
  // Same for DaemonPtyAdapter — tests assert the replacement adapter is fresh but its respawn closure targets the *original* spawner.
  const adapterInstances: MockAdapter[] = []
  // Why: adapters are built inside initDaemonPtyProvider, so tests set this before init to make listSessions report live sessions.
  const defaultListSessionsSessions: { sessionId: string }[] = []
  const listProcessesControl: {
    current: null | (() => Promise<{ sessionId: string }[]>)
  } = { current: null }

  const localFallbackProvider = {
    routesFreshSpawnsToLocalProvider: undefined,
    spawn: vi.fn(async (opts: { sessionId?: string }) => ({
      id: opts.sessionId ?? 'local-fallback-pty'
    })),
    attach: vi.fn(async () => {}),
    hasPty: vi.fn(() => false),
    write: vi.fn(),
    resize: vi.fn(),
    shutdown: vi.fn(async () => {}),
    sendSignal: vi.fn(async () => {}),
    getCwd: vi.fn(async () => ''),
    getInitialCwd: vi.fn(async () => ''),
    clearBuffer: vi.fn(async () => {}),
    acknowledgeDataEvent: vi.fn(),
    hasChildProcesses: vi.fn(async () => false),
    getForegroundProcess: vi.fn(async () => null),
    serialize: vi.fn(async () => '{}'),
    revive: vi.fn(async () => {}),
    listProcesses: vi.fn(async () => []),
    getDefaultShell: vi.fn(async () => '/bin/zsh'),
    getProfiles: vi.fn(async () => []),
    onData: vi.fn(() => () => {}),
    onReplay: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {})
  }
  const getLocalPtyProviderMock = vi.fn(() => localFallbackProvider)
  const setLocalPtyProviderMock = vi.fn()
  const unbindLocalProviderListenersMock = vi.fn()
  const rebindLocalProviderListenersMock = vi.fn()

  return {
    getPathMock,
    getAppPathMock,
    isPackagedMock,
    probeSocketExistsMock,
    writeFileSyncMock,
    readFileSyncMock,
    unlinkSyncMock,
    netConnectMock,
    forkMock,
    checkDaemonHealthMock,
    healthCheckDaemonMock,
    getMacDaemonSystemResolverHealthMock,
    getDaemonLaunchIdentityMock,
    isDaemonStaleForCurrentBundleMock,
    killStaleDaemonMock,
    getProcessStartedAtMsMock,
    parseDaemonPidFileMock,
    unlinkOwnedDaemonPidFileMock,
    daemonClientMock,
    spawnerInstances,
    ensureRunningOverrides,
    adoptionLeaseReleases,
    lifecycleLeaseErrors,
    disconnectOnlyErrors,
    routerSubscriptionError,
    adapterInstances,
    defaultListSessionsSessions,
    listProcessesControl,
    getLocalPtyProviderMock,
    localFallbackProvider,
    setLocalPtyProviderMock,
    unbindLocalProviderListenersMock,
    rebindLocalProviderListenersMock
  }
})

type MockSpawner = {
  ensureRunning: ReturnType<typeof vi.fn>
  resetHandle: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  getHandle: ReturnType<typeof vi.fn>
  launcher: unknown
}

type MockAdapter = {
  protocolVersion: number
  options: {
    socketPath: string
    tokenPath: string
    historyPath?: string
    respawn?: () => Promise<void>
    protocolVersion?: number
  }
  getActiveSessionIds: ReturnType<typeof vi.fn>
  fanoutSyntheticExits: ReturnType<typeof vi.fn>
  listProcesses: ReturnType<typeof vi.fn>
  listSessions: ReturnType<typeof vi.fn>
  establishLifecycleLease: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  disconnectOnly: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  // Why: the router calls onData/onExit on each adapter; the stub returns a no-op unsubscribe so router subscription doesn't explode.
  callOrder: string[]
}

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return isPackagedMock()
    },
    getPath: getPathMock,
    getAppPath: getAppPathMock,
    getVersion: () => '1.2.3'
  }
}))

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: (p: string) => probeSocketExistsMock(p) || p.includes('.pid'),
  unlinkSync: unlinkSyncMock,
  readFileSync: readFileSyncMock,
  writeFileSync: writeFileSyncMock
}))

vi.mock('child_process', () => ({ fork: forkMock }))

vi.mock('net', () => ({ connect: netConnectMock }))

vi.mock('./daemon-health', () => ({
  checkDaemonHealth: checkDaemonHealthMock,
  getDaemonLaunchIdentity: getDaemonLaunchIdentityMock,
  getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock,
  healthCheckDaemon: healthCheckDaemonMock,
  isDaemonStaleForCurrentBundle: isDaemonStaleForCurrentBundleMock,
  killStaleDaemon: killStaleDaemonMock,
  getProcessStartedAtMs: getProcessStartedAtMsMock,
  parseDaemonPidFile: parseDaemonPidFileMock
}))

vi.mock('./client', () => ({ DaemonClient: daemonClientMock }))

vi.mock('./daemon-spawner', () => ({
  DaemonSpawner: class MockDaemonSpawner {
    readonly launcher: unknown
    readonly ensureRunning: ReturnType<typeof vi.fn>
    readonly resetHandle: ReturnType<typeof vi.fn>
    readonly shutdown: ReturnType<typeof vi.fn>
    readonly getHandle: ReturnType<typeof vi.fn>
    private socketCounter: number
    private handle: {
      mode?: 'degraded-new-pty-fallback'
      releaseAdoptionLease?: () => void
      shutdown: () => Promise<void>
    } | null
    constructor(opts: { runtimeDir: string; launcher: unknown }) {
      this.launcher = opts.launcher
      this.socketCounter = 0
      this.handle = null
      // Why: each ensureRunning bumps a counter into socketPath so tests can tell the replacement adapter used the second call, not the first.
      this.ensureRunning = vi.fn(async () => {
        const override = ensureRunningOverrides.shift()
        if (override) {
          const result = await override()
          const releaseAdoptionLease = vi.fn()
          adoptionLeaseReleases.push(releaseAdoptionLease)
          this.handle = { releaseAdoptionLease, shutdown: vi.fn(async () => {}) }
          if (result.mode) {
            this.handle.mode = result.mode
          }
          return {
            socketPath: result.socketPath,
            tokenPath: result.tokenPath
          }
        }
        this.socketCounter += 1
        const releaseAdoptionLease = vi.fn()
        adoptionLeaseReleases.push(releaseAdoptionLease)
        this.handle = { releaseAdoptionLease, shutdown: vi.fn(async () => {}) }
        return {
          socketPath: `/fake/socket-${this.socketCounter}`,
          tokenPath: `/fake/token-${this.socketCounter}`
        }
      })
      this.resetHandle = vi.fn()
      this.shutdown = vi.fn(async () => {})
      this.getHandle = vi.fn(() => this.handle)
      spawnerInstances.push(this as unknown as MockSpawner)
    }
  },
  getDaemonSocketPath: (_dir: string, version?: number) =>
    `/fake/daemon/daemon-v${version ?? PROTOCOL_VERSION}.sock`,
  getDaemonTokenPath: (_dir: string, version?: number) =>
    `/fake/daemon/daemon-v${version ?? PROTOCOL_VERSION}.token`,
  getDaemonPidPath: (_dir: string, version?: number) =>
    `/fake/daemon/daemon-v${version ?? PROTOCOL_VERSION}.pid`,
  serializeDaemonPidFile: (obj: unknown) => JSON.stringify(obj),
  unlinkOwnedDaemonPidFile: unlinkOwnedDaemonPidFileMock
}))

vi.mock('./daemon-pty-adapter', () => ({
  DaemonPtyAdapter: class MockDaemonPtyAdapter {
    readonly protocolVersion: number
    readonly options: MockAdapter['options']
    readonly getActiveSessionIds: ReturnType<typeof vi.fn>
    readonly fanoutSyntheticExits: ReturnType<typeof vi.fn>
    readonly listProcesses: ReturnType<typeof vi.fn>
    readonly listSessions: ReturnType<typeof vi.fn>
    readonly establishLifecycleLease: ReturnType<typeof vi.fn>
    readonly shutdown: ReturnType<typeof vi.fn>
    readonly dispose: ReturnType<typeof vi.fn>
    readonly disconnectOnly: ReturnType<typeof vi.fn>
    readonly onData: ReturnType<typeof vi.fn>
    readonly onExit: ReturnType<typeof vi.fn>
    readonly callOrder: string[]
    constructor(opts: MockAdapter['options']) {
      this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
      this.options = opts
      this.callOrder = []
      this.getActiveSessionIds = vi.fn(() => [] as string[])
      this.fanoutSyntheticExits = vi.fn(() => {
        this.callOrder.push('fanoutSyntheticExits')
      })
      this.listProcesses = vi.fn(async () =>
        listProcessesControl.current ? listProcessesControl.current() : []
      )
      this.listSessions = vi.fn(async () => [...defaultListSessionsSessions])
      const lifecycleLeaseError = lifecycleLeaseErrors.shift()
      this.establishLifecycleLease = vi.fn(async () => {
        if (lifecycleLeaseError) {
          throw lifecycleLeaseError
        }
      })
      this.shutdown = vi.fn(async () => {})
      this.dispose = vi.fn()
      const disconnectOnlyError = disconnectOnlyErrors.shift()
      this.disconnectOnly = vi.fn(async () => {
        if (disconnectOnlyError) {
          throw disconnectOnlyError
        }
      })
      this.onData = vi.fn(() => {
        if (routerSubscriptionError.current) {
          const error = routerSubscriptionError.current
          routerSubscriptionError.current = null
          throw error
        }
        return () => {}
      })
      this.onExit = vi.fn(() => () => {})
      adapterInstances.push(this as unknown as MockAdapter)
    }
  }
}))

vi.mock('../ipc/pty', () => ({
  getLocalPtyProvider: getLocalPtyProviderMock,
  setLocalPtyProvider: setLocalPtyProviderMock,
  unbindLocalProviderListeners: unbindLocalProviderListenersMock,
  rebindLocalProviderListeners: rebindLocalProviderListenersMock
}))

async function importFresh() {
  vi.resetModules()
  spawnerInstances.length = 0
  ensureRunningOverrides.length = 0
  adoptionLeaseReleases.length = 0
  lifecycleLeaseErrors.length = 0
  disconnectOnlyErrors.length = 0
  routerSubscriptionError.current = null
  adapterInstances.length = 0
  defaultListSessionsSessions.length = 0
  listProcessesControl.current = null
  getLocalPtyProviderMock.mockClear()
  localFallbackProvider.spawn.mockClear()
  localFallbackProvider.write.mockClear()
  localFallbackProvider.onData.mockClear()
  localFallbackProvider.onExit.mockClear()
  setLocalPtyProviderMock.mockClear()
  unbindLocalProviderListenersMock.mockClear()
  rebindLocalProviderListenersMock.mockClear()
  checkDaemonHealthMock.mockClear()
  checkDaemonHealthMock.mockResolvedValue('healthy')
  healthCheckDaemonMock.mockClear()
  healthCheckDaemonMock.mockResolvedValue(true)
  getMacDaemonSystemResolverHealthMock.mockReset()
  getMacDaemonSystemResolverHealthMock.mockReturnValue('healthy')
  getDaemonLaunchIdentityMock.mockClear()
  isDaemonStaleForCurrentBundleMock.mockReset()
  isDaemonStaleForCurrentBundleMock.mockReturnValue(false)
  killStaleDaemonMock.mockClear()
  getAppPathMock.mockReset()
  getAppPathMock.mockReturnValue('/fake/app')
  forkMock.mockReset()
  isPackagedMock.mockReset()
  isPackagedMock.mockReturnValue(false)
  daemonClientMock.mockReset()
  daemonClientMock.mockImplementation(function MockDaemonClient() {
    return {
      ensureConnected: vi.fn(async () => {}),
      request: vi.fn(async () => ({ sessions: [] })),
      disconnect: vi.fn()
    }
  })
  probeSocketExistsMock.mockClear()
  writeFileSyncMock.mockClear()
  readFileSyncMock.mockReset()
  readFileSyncMock.mockImplementation(() => {
    throw new Error('ENOENT')
  })
  unlinkSyncMock.mockClear()
  parseDaemonPidFileMock.mockReset()
  parseDaemonPidFileMock.mockReturnValue(null)
  unlinkOwnedDaemonPidFileMock.mockReset()
  unlinkOwnedDaemonPidFileMock.mockReturnValue(true)
  getProcessStartedAtMsMock.mockReset()
  getProcessStartedAtMsMock.mockReturnValue(1_000_000)
  // Why: import after resetModules so module-level spawner/adapter/restartInFlight start fresh — needed to test first-init and the coalescer.
  return import('./daemon-init')
}

function mockConnectedAdoptionClientOnce(): void {
  daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
    return {
      ensureConnected: vi.fn(async () => {}),
      request: vi.fn(),
      disconnect: vi.fn()
    }
  })
}

function mockOnlyDaemonSocketAlive(socketSuffix: string): void {
  netConnectMock.mockImplementation((options?: { path?: string }) => {
    const live = options?.path?.endsWith(socketSuffix) ?? false
    const handlers: Record<string, (() => void)[]> = { connect: [], error: [] }
    return {
      on(event: string, callback: () => void) {
        handlers[event]?.push(callback)
        if ((live && event === 'connect') || (!live && event === 'error')) {
          queueMicrotask(() => callback())
        }
        return this
      },
      removeListener(event: string, callback: () => void) {
        handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
        return this
      },
      destroy() {}
    }
  })
}

describe('daemon-init: runRestartDaemon (7-step sequence)', () => {
  beforeEach(() => {
    probeSocketExistsMock.mockReturnValue(false)
    netConnectMock.mockReset()
    netConnectMock.mockImplementation(() => {
      const handlers: Record<string, (() => void)[]> = { connect: [], error: [] }
      return {
        on(event: string, cb: () => void) {
          handlers[event]?.push(cb)
          if (event === 'error') {
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
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('re-binds listeners after the first daemon provider is installed', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    expect(setLocalPtyProviderMock).toHaveBeenCalledTimes(1)
    expect(rebindLocalProviderListenersMock).toHaveBeenCalledTimes(1)
    expect(rebindLocalProviderListenersMock.mock.invocationCallOrder[0]).toBeGreaterThan(
      setLocalPtyProviderMock.mock.invocationCallOrder[0]
    )
    expect(adapterInstances[0].establishLifecycleLease).toHaveBeenCalledOnce()
    expect(adapterInstances[0].establishLifecycleLease.mock.invocationCallOrder[0]).toBeLessThan(
      setLocalPtyProviderMock.mock.invocationCallOrder[0]
    )
    expect(adoptionLeaseReleases[0]).toHaveBeenCalledOnce()
    expect(adapterInstances[0].establishLifecycleLease.mock.invocationCallOrder[0]).toBeLessThan(
      adoptionLeaseReleases[0].mock.invocationCallOrder[0]
    )
  })

  it('uses daemon-owned idle retirement when a fresh launch fails permanent adoption', async () => {
    const mod = await importFresh()
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/launched-socket',
      tokenPath: '/fake/launched-token'
    }))
    lifecycleLeaseErrors.push(new Error('lease identity mismatch'))

    await expect(mod.initDaemonPtyProvider()).rejects.toThrow('lease identity mismatch')

    expect(adoptionLeaseReleases[0]).toHaveBeenCalledOnce()
    expect(adapterInstances[0].disconnectOnly).toHaveBeenCalledOnce()
    expect(adapterInstances[0].dispose).not.toHaveBeenCalled()
    expect(spawnerInstances[0].shutdown).not.toHaveBeenCalled()
    expect(adapterInstances[0].establishLifecycleLease.mock.invocationCallOrder[0]).toBeLessThan(
      adoptionLeaseReleases[0].mock.invocationCallOrder[0]
    )
    expect(setLocalPtyProviderMock).not.toHaveBeenCalled()
  })

  it('does not kill a preserved daemon when startup lease acquisition fails', async () => {
    const mod = await importFresh()
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/preserved-socket',
      tokenPath: '/fake/preserved-token'
    }))
    lifecycleLeaseErrors.push(new Error('preserved lease failed'))

    await expect(mod.initDaemonPtyProvider()).rejects.toThrow('preserved lease failed')

    expect(adoptionLeaseReleases[0]).toHaveBeenCalledOnce()
    expect(adapterInstances[0].disconnectOnly).toHaveBeenCalledOnce()
    expect(spawnerInstances[0].shutdown).not.toHaveBeenCalled()
    expect(setLocalPtyProviderMock).not.toHaveBeenCalled()
  })

  it('prunes seeded Claude live-PTY ids against daemon sessions after init', async () => {
    const mod = await importFresh()
    // Why: live-pty-gate is intentionally unmocked — import from the same fresh registry so gate state matches daemon-init's.
    const gate = await import('../claude-accounts/live-pty-gate')
    defaultListSessionsSessions.push({ sessionId: 'claude-alive' })
    gate.seedLiveClaudePtysFromPersistence(['claude-alive', 'claude-dead'])
    try {
      await mod.initDaemonPtyProvider()

      expect(gate.hasLiveClaudePtys()).toBe(true)

      gate.markClaudePtyExited('claude-alive')
      // Why: proves 'claude-dead' was released by the daemon reconcile — the surviving session held the gate alone.
      expect(gate.hasLiveClaudePtys()).toBe(false)
    } finally {
      gate.markClaudePtyExited('claude-alive')
      gate.markClaudePtyExited('claude-dead')
    }
  })

  it('does not install a late daemon provider after startup fallback aborts the init attempt', async () => {
    const mod = await importFresh()
    let resolveEnsureRunning!: (value: { socketPath: string; tokenPath: string }) => void
    ensureRunningOverrides.push(
      () =>
        new Promise((resolve) => {
          resolveEnsureRunning = resolve
        })
    )
    const abortController = new AbortController()

    const started = mod.initDaemonPtyProvider(abortController.signal)
    await Promise.resolve()

    expect(spawnerInstances).toHaveLength(1)
    expect(spawnerInstances[0].ensureRunning).toHaveBeenCalledTimes(1)

    abortController.abort()
    resolveEnsureRunning({ socketPath: '/fake/socket-late', tokenPath: '/fake/token-late' })
    await started

    expect(adapterInstances).toHaveLength(1)
    expect(adapterInstances[0].disconnectOnly).toHaveBeenCalledOnce()
    expect(adapterInstances[0].establishLifecycleLease).not.toHaveBeenCalled()
    expect(setLocalPtyProviderMock).not.toHaveBeenCalled()
    expect(rebindLocalProviderListenersMock).not.toHaveBeenCalled()
    expect(mod.getDaemonProvider()).toBeNull()
  })

  it('disconnects uninstalled adapter leases when startup aborts during legacy discovery', async () => {
    const mod = await importFresh()
    probeSocketExistsMock.mockImplementation((p?: string) => p?.endsWith('daemon-v9.sock') ?? false)
    mockOnlyDaemonSocketAlive('daemon-v9.sock')
    let resolveDiscovery!: (sessions: { sessionId: string }[]) => void
    const discovery = new Promise<{ sessionId: string }[]>((resolve) => {
      resolveDiscovery = resolve
    })
    listProcessesControl.current = () => discovery
    const abortController = new AbortController()

    const started = mod.initDaemonPtyProvider(abortController.signal)
    await vi.waitFor(() => {
      expect(adapterInstances.some((instance) => instance.protocolVersion === 9)).toBe(true)
      expect(
        adapterInstances.some((instance) => instance.listProcesses.mock.calls.length > 0)
      ).toBe(true)
    })
    abortController.abort()
    resolveDiscovery([])
    await started

    expect(adapterInstances).toHaveLength(2)
    expect(adapterInstances[0].disconnectOnly).toHaveBeenCalledOnce()
    expect(adapterInstances[1].disconnectOnly).toHaveBeenCalledOnce()
    expect(setLocalPtyProviderMock).not.toHaveBeenCalled()
    expect(mod.getDaemonProvider()).toBeNull()
  })

  it('retains every adapter cleanup failure when legacy router setup aborts', async () => {
    const mod = await importFresh()
    probeSocketExistsMock.mockImplementation(
      (path?: string) => path?.endsWith('daemon-v9.sock') ?? false
    )
    mockOnlyDaemonSocketAlive('daemon-v9.sock')
    const discoveryError = new Error('router subscription failed')
    const currentCleanupError = new Error('current cleanup failed')
    const legacyCleanupError = new Error('legacy cleanup failed')
    routerSubscriptionError.current = discoveryError
    disconnectOnlyErrors.push(currentCleanupError, legacyCleanupError)

    const error = await mod.initDaemonPtyProvider().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AggregateError)
    const topLevelErrors = (error as AggregateError).errors
    expect(topLevelErrors[0]).toBe(discoveryError)
    expect(topLevelErrors[1]).toBeInstanceOf(AggregateError)
    expect((topLevelErrors[1] as AggregateError).errors).toEqual([
      legacyCleanupError,
      currentCleanupError
    ])
    expect(adapterInstances[0].disconnectOnly).toHaveBeenCalledOnce()
    expect(adapterInstances[1].disconnectOnly).toHaveBeenCalledOnce()
  })

  it('routes fresh PTYs to the local fallback when a preserved daemon cannot spawn new PTYs', async () => {
    const mod = await importFresh()
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/degraded-socket',
      tokenPath: '/fake/degraded-token',
      mode: 'degraded-new-pty-fallback'
    }))

    await mod.initDaemonPtyProvider()

    const { DegradedDaemonPtyProvider } = await import('./degraded-daemon-pty-provider')
    const provider = mod.getDaemonProvider()
    expect(provider).toBeInstanceOf(DegradedDaemonPtyProvider)
    expect(getLocalPtyProviderMock).toHaveBeenCalledOnce()
    expect(setLocalPtyProviderMock).toHaveBeenCalledWith(provider)

    const result = await provider!.spawn({ cols: 80, rows: 24 })

    expect(result.id).toBe('local-fallback-pty')
    expect(localFallbackProvider.spawn).toHaveBeenCalledWith({ cols: 80, rows: 24 })
    expect(adapterInstances[0].listProcesses).toHaveBeenCalled()
  })

  it('fans pty:exit for every active session *before* unbinding listeners, and killedCount is captured pre-fanout', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // Why: seed active sessions and mock the snapshot-then-clear so a regression measuring killedCount *after* fanout surfaces as 0.
    const originalAdapter = adapterInstances[0]
    let activeIds = ['sess-a', 'sess-b', 'sess-c']
    originalAdapter.getActiveSessionIds.mockImplementation(() => [...activeIds])

    const order: string[] = []
    originalAdapter.fanoutSyntheticExits.mockImplementation(() => {
      order.push('fanout')
      activeIds = []
    })
    unbindLocalProviderListenersMock.mockImplementation(() => {
      order.push('unbind')
    })

    const result = await mod.restartDaemon()

    // killedCount must be 3 — proves the count was taken *before* fanout cleared the set (a swapped-order bug reports 0).
    expect(result.killedCount).toBe(3)
    expect(originalAdapter.fanoutSyntheticExits).toHaveBeenCalledWith(-1)
    // Ordering invariant: synthetic exits must reach the renderer *before* listeners are torn down (Step 1 before 2).
    expect(order).toEqual(['fanout', 'unbind'])
  })

  it('uses daemon-owned idle retirement after a failed manual-restart adoption', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const originalProvider = mod.getDaemonProvider()
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/restart-failure-socket',
      tokenPath: '/fake/restart-failure-token'
    }))
    lifecycleLeaseErrors.push(new Error('restart lease failed'))

    await expect(mod.restartDaemon()).rejects.toThrow('restart lease failed')

    expect(adoptionLeaseReleases[1]).toHaveBeenCalledOnce()
    expect(adapterInstances[1].disconnectOnly).toHaveBeenCalledOnce()
    expect(spawnerInstances[0].shutdown).not.toHaveBeenCalled()
    expect(mod.getDaemonProvider()).toBe(originalProvider)
    expect(unbindLocalProviderListenersMock).toHaveBeenCalledOnce()
    expect(rebindLocalProviderListenersMock).toHaveBeenCalledTimes(2)
  })

  it('fans exits for preserved degraded current-daemon sessions during restart', async () => {
    const mod = await importFresh()
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/degraded-socket',
      tokenPath: '/fake/degraded-token',
      mode: 'degraded-new-pty-fallback'
    }))
    await mod.initDaemonPtyProvider()

    const { DegradedDaemonPtyProvider } = await import('./degraded-daemon-pty-provider')
    const provider = mod.getDaemonProvider()
    expect(provider).toBeInstanceOf(DegradedDaemonPtyProvider)
    const degradedProvider = provider as InstanceType<typeof DegradedDaemonPtyProvider>

    const originalAdapter = adapterInstances[0]
    originalAdapter.listProcesses.mockResolvedValueOnce([
      { id: 'preserved-current-session', cwd: '/repo', title: 'shell' }
    ])
    await degradedProvider.discoverDaemonSessions()

    const order: string[] = []
    degradedProvider.onExit((payload) => {
      if (payload.id === 'preserved-current-session') {
        order.push('degraded-fanout')
      }
    })
    originalAdapter.fanoutSyntheticExits.mockImplementation(() => {
      order.push('adapter-fanout')
    })
    unbindLocalProviderListenersMock.mockImplementation(() => {
      order.push('unbind')
    })

    const result = await mod.restartDaemon()

    expect(result.killedCount).toBe(1)
    expect(order).toEqual(['adapter-fanout', 'degraded-fanout', 'unbind'])
  })

  it('reuses the existing DaemonSpawner across restart (resetHandle + ensureRunning on same instance)', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    expect(spawnerInstances).toHaveLength(1)
    const originalSpawner = spawnerInstances[0]
    expect(originalSpawner.ensureRunning).toHaveBeenCalledTimes(1)

    await mod.restartDaemon()

    // No second DaemonSpawner was constructed — restart uses the one from init.
    expect(spawnerInstances).toHaveLength(1)
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(originalSpawner.ensureRunning).toHaveBeenCalledTimes(2)
  })

  it('builds a fresh adapter whose respawn callback closes over the same spawner', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const originalSpawner = spawnerInstances[0]
    const originalAdapter = adapterInstances[0]

    await mod.restartDaemon()

    // A new adapter was constructed against the replacement daemon's socket.
    expect(adapterInstances).toHaveLength(2)
    const replacementAdapter = adapterInstances[1]
    expect(replacementAdapter).not.toBe(originalAdapter)
    expect(replacementAdapter.options.socketPath).toBe('/fake/socket-2')
    expect(replacementAdapter.options.tokenPath).toBe('/fake/token-2')

    // The replacement adapter's respawn closure must drive the *same* original spawner (see daemon-init.ts step 5).
    originalSpawner.resetHandle.mockClear()
    originalSpawner.ensureRunning.mockClear()
    await replacementAdapter.options.respawn?.()
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(originalSpawner.ensureRunning).toHaveBeenCalledTimes(1)
    // Still only one spawner in the whole test — nobody new was constructed.
    expect(spawnerInstances).toHaveLength(1)
  })

  it('swaps the module-level adapter and re-binds listeners after the new provider is installed', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // initDaemonPtyProvider calls setLocalPtyProvider once with the original.
    expect(setLocalPtyProviderMock).toHaveBeenCalledTimes(1)
    const originalProvider = setLocalPtyProviderMock.mock.calls[0][0]
    expect(originalProvider).toBe(adapterInstances[0])
    expect(mod.getDaemonProvider()).toBe(originalProvider)

    await mod.restartDaemon()

    const replacementAdapter = adapterInstances[1]
    // Second call: swap to the replacement provider (Step 6).
    expect(setLocalPtyProviderMock).toHaveBeenCalledTimes(2)
    expect(setLocalPtyProviderMock.mock.calls[1][0]).toBe(replacementAdapter)
    expect(mod.getDaemonProvider()).toBe(replacementAdapter)

    // Step 7: rebind must run *after* Step 6 (the provider swap).
    const rebindOrder = rebindLocalProviderListenersMock.mock.invocationCallOrder.at(-1) ?? -1
    const swapOrder = setLocalPtyProviderMock.mock.invocationCallOrder.at(-1) ?? -1
    expect(rebindOrder).toBeGreaterThan(swapOrder)
  })

  it('preserves legacy adapter instances by identity, drains outgoing router via disposeRouterOnly, and re-discovers legacy sessions on the new router', async () => {
    const mod = await importFresh()

    // Why: bypass createLegacyDaemonAdapters' socket-probe machinery — directly construct a router with a legacy adapter and install it.
    await mod.initDaemonPtyProvider()

    const { DaemonPtyRouter } = await import('./daemon-pty-router')
    const { DaemonPtyAdapter } = await import('./daemon-pty-adapter')
    const currentAtConstruction = adapterInstances[0]
    const legacyAdapter = new DaemonPtyAdapter({
      socketPath: '/fake/legacy.sock',
      tokenPath: '/fake/legacy.token',
      protocolVersion: 3
    })
    const routerWithLegacy = new DaemonPtyRouter({
      current: currentAtConstruction as unknown as InstanceType<typeof DaemonPtyAdapter>,
      legacy: [legacyAdapter as unknown as InstanceType<typeof DaemonPtyAdapter>]
    })
    // Why: spy on the outgoing router's disposeRouterOnly — adapter survival alone wouldn't catch a no-op that leaks listeners.
    const disposeRouterOnlySpy = vi.spyOn(routerWithLegacy, 'disposeRouterOnly')
    const oldRouterDispose = vi.spyOn(routerWithLegacy, 'dispose')
    mod.replaceDaemonProvider(routerWithLegacy)

    await mod.restartDaemon()

    const provider = mod.getDaemonProvider()
    expect(provider).toBeInstanceOf(DaemonPtyRouter)
    const newRouter = provider as InstanceType<typeof DaemonPtyRouter>
    expect(newRouter).not.toBe(routerWithLegacy)

    // Legacy adapter is preserved by identity — not reconstructed, copied, or disposed.
    const legacies = newRouter.getLegacyAdapters()
    expect(legacies).toHaveLength(1)
    expect(legacies[0]).toBe(legacyAdapter)
    expect(legacyAdapter.dispose).not.toHaveBeenCalled()
    // Router drained via disposeRouterOnly (router-only teardown), so legacy adapters' connections are untouched.
    expect(legacyAdapter.disconnectOnly).not.toHaveBeenCalled()
    // disposeRouterOnly drained subscriptions but did NOT dispose the adapters behind it.
    expect(disposeRouterOnlySpy).toHaveBeenCalledTimes(1)
    expect(oldRouterDispose).not.toHaveBeenCalled()

    // The replacement router re-runs discovery so spawns for a surviving legacy sessionId still route to the legacy adapter.
    expect(legacyAdapter.listProcesses).toHaveBeenCalled()
  })

  it('routes affected v9 daemon sessions through a legacy adapter on launch', async () => {
    const mod = await importFresh()
    probeSocketExistsMock.mockImplementation((p?: string) => p?.endsWith('daemon-v9.sock') ?? false)
    mockOnlyDaemonSocketAlive('daemon-v9.sock')

    await mod.initDaemonPtyProvider()

    const { DaemonPtyRouter } = await import('./daemon-pty-router')
    expect(mod.getDaemonProvider()).toBeInstanceOf(DaemonPtyRouter)
    expect(adapterInstances.some((instance) => instance.protocolVersion === 9)).toBe(true)
  })

  it('restart path with no legacy adapters yields a bare DaemonPtyAdapter (not wrapped in a router)', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // initDaemonPtyProvider yields a bare adapter when no legacy adapters exist — confirm that shape persists across restart.
    const { DaemonPtyAdapter } = await import('./daemon-pty-adapter')
    const { DaemonPtyRouter } = await import('./daemon-pty-router')
    expect(mod.getDaemonProvider()).toBeInstanceOf(DaemonPtyAdapter)

    await mod.restartDaemon()

    expect(mod.getDaemonProvider()).toBeInstanceOf(DaemonPtyAdapter)
    expect(mod.getDaemonProvider()).not.toBeInstanceOf(DaemonPtyRouter)
  })

  it('orders Step 3 (cleanup) → Step 4 (resetHandle + ensureRunning) → Step 5 (new adapter) → Step 6 (replaceProvider) → Step 7 (rebind)', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const originalSpawner = spawnerInstances[0]
    const originalAdapter = adapterInstances[0]

    // Build an ordered trace by stamping each step; cleanup has no observable in the default probeSocket=false path, so instrument resetHandle instead.
    const trace: string[] = []
    originalAdapter.fanoutSyntheticExits.mockImplementation(() => trace.push('fanout'))
    unbindLocalProviderListenersMock.mockImplementation(() => trace.push('unbind'))
    originalSpawner.resetHandle.mockImplementation(() => trace.push('resetHandle'))
    const originalEnsureRunning = originalSpawner.ensureRunning
    originalSpawner.ensureRunning.mockImplementation(async () => {
      trace.push('ensureRunning')
      return {
        socketPath: '/fake/socket-2',
        tokenPath: '/fake/token-2'
      }
    })
    setLocalPtyProviderMock.mockImplementation(() => trace.push('replaceProvider'))
    rebindLocalProviderListenersMock.mockImplementation(() => trace.push('rebind'))

    await mod.restartDaemon()
    void originalEnsureRunning // keep ref so tslint doesn't complain

    // Full 7-step order; Step 3 (cleanup) has no observable in the dead-socket branch, so it's pinned implicitly by resetHandle running after unbind.
    expect(trace).toEqual([
      'fanout',
      'unbind',
      'resetHandle',
      'ensureRunning',
      'replaceProvider',
      'rebind'
    ])

    // A fresh adapter built between ensureRunning and replaceProvider (Step 5 before 6); its Step-4 socketPath proves the ordering.
    expect(adapterInstances).toHaveLength(2)
    expect(adapterInstances[1].options.socketPath).toBe('/fake/socket-2')
    expect(adapterInstances[1].establishLifecycleLease).toHaveBeenCalledOnce()
    expect(adapterInstances[1].establishLifecycleLease.mock.invocationCallOrder[0]).toBeLessThan(
      setLocalPtyProviderMock.mock.invocationCallOrder.at(-1) as number
    )
  })

  it('exercises the alive-daemon cleanup path: issues shutdown RPC via DaemonClient before spawning a replacement', async () => {
    // Why: default probeSocket=false skips Step 3's shutdown RPC; flip the socket "alive" to cover the shutdown-RPC-succeeded branch.

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return { sessions: [{ sessionId: 'live-1', isAlive: true }] }
      }
      // `shutdown` RPC — daemon exits before reply lands; return undefined.
      return undefined
    })
    const ensureConnectedMock = vi.fn(async () => {})
    const disconnectMock = vi.fn()
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    daemonClientMock.mockImplementationOnce(function MockDaemonClientForShutdown() {
      return {
        ensureConnected: ensureConnectedMock,
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    // Make probeSocket return true: needs both the fs.existsSync proxy AND net.connect resolving "alive".
    probeSocketExistsMock.mockReturnValue(true)
    netConnectMock.mockImplementationOnce(() => {
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
    })

    await mod.restartDaemon()

    // The shutdown RPC must have been issued with killSessions=true.
    expect(ensureConnectedMock).toHaveBeenCalled()
    expect(requestMock).toHaveBeenCalledWith('shutdown', { killSessions: true })
    // The fallback killStaleDaemon must NOT fire when the RPC path worked.
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
  })

  it('cleans up daemon socket probe listeners when the probe times out', async () => {
    vi.useFakeTimers()
    try {
      const handlers: Record<string, Set<() => void>> = {
        connect: new Set(),
        error: new Set()
      }
      const socket = {
        on(event: string, cb: () => void) {
          handlers[event]?.add(cb)
          return this
        },
        removeListener(event: string, cb: () => void) {
          handlers[event]?.delete(cb)
          return this
        },
        destroy: vi.fn(),
        listenerCount(event: string) {
          return handlers[event]?.size ?? 0
        }
      }
      probeSocketExistsMock.mockReturnValue(true)
      netConnectMock.mockReturnValueOnce(socket)
      const mod = await importFresh()

      const cleanup = mod.cleanupDaemonForProtocol('/fake/daemon', PROTOCOL_VERSION)
      await Promise.resolve()

      expect(socket.listenerCount('connect')).toBe(1)
      expect(socket.listenerCount('error')).toBe(1)

      await vi.advanceTimersByTimeAsync(1000)

      await expect(cleanup).resolves.toEqual({ cleaned: false, killedCount: 0 })
      expect(socket.destroy).toHaveBeenCalledTimes(1)
      expect(socket.listenerCount('connect')).toBe(0)
      expect(socket.listenerCount('error')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('coalesces concurrent restartDaemon() calls so the 7-step sequence runs exactly once', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const originalSpawner = spawnerInstances[0]

    // Why: the deferred gate holds the first restart inside ensureRunning so the second call provably enters while the first is mid-flight.
    let markEnsureRunningEntered: (() => void) | undefined
    const ensureRunningEntered = new Promise<void>((resolve) => {
      markEnsureRunningEntered = resolve
    })
    let releaseEnsureRunning: (() => void) | undefined
    const ensureRunningBarrier = new Promise<void>((resolve) => {
      releaseEnsureRunning = resolve
    })
    originalSpawner.ensureRunning.mockImplementationOnce(async () => {
      markEnsureRunningEntered?.()
      await ensureRunningBarrier
      return { socketPath: '/fake/socket-2', tokenPath: '/fake/token-2' }
    })

    const call1 = mod.restartDaemon()
    await ensureRunningEntered
    const call2 = mod.restartDaemon()

    // Why: restartDaemon wraps each return in a fresh Promise, so call1===call2 can't prove coalescing; instead assert resetHandle stayed at 1 mid-flight.
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(adapterInstances).toHaveLength(1)

    releaseEnsureRunning?.()
    const [r1, r2] = await Promise.all([call1, call2])
    // Both resolved values are structurally identical — same result bubbled up through the shared runRestartDaemon promise.
    expect(r1).toEqual(r2)

    // resetHandle=1/restart, ensureRunning=1 init+1 restart; an un-coalesced second restart would push these to 2 and 3.
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(originalSpawner.ensureRunning).toHaveBeenCalledTimes(2)
    expect(adapterInstances).toHaveLength(2)

    // After the in-flight promise settles, a fresh restart runs — proves .finally cleared restartInFlight (a stale slot would skip work).
    await mod.restartDaemon()
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(2)
    expect(adapterInstances).toHaveLength(3)
  })

  it('throws when restartDaemon is called before initDaemonPtyProvider', async () => {
    const mod = await importFresh()
    await expect(mod.restartDaemon()).rejects.toThrow(
      'restartDaemon called before initDaemonPtyProvider'
    )
  })

  it('respawns instead of reusing a healthy daemon launched from another app path', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider(undefined, { macosLoginSessionWatch: true })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 12345,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          if (event === 'message') {
            queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await launcher('/fake/socket', '/fake/token')

    expect(getDaemonLaunchIdentityMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      FAKE_DAEMON_ENTRY_PATH
    )
    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalledWith(
      FAKE_DAEMON_ENTRY_PATH,
      expect.arrayContaining([
        '--socket',
        '/fake/socket',
        '--token',
        '/fake/token',
        '--login-session-watch',
        '--log-file',
        join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log')
      ]),
      expect.objectContaining({ cwd: '/fake/userData', detached: true })
    )
  })

  it('holds a full adoption pair before a healthy launcher resolves', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const events: string[] = []
    const disconnect = vi.fn()
    daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {
          events.push('full-pair')
        }),
        request: vi.fn(),
        disconnect
      }
    })
    checkDaemonHealthMock.mockImplementationOnce(async () => {
      events.push('health')
      return 'healthy'
    })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{
      releaseAdoptionLease?(): void
      shutdown(): Promise<void>
    }>

    const handle = await launcher('/fake/socket', '/fake/token')

    expect(events[0]).toBe('full-pair')
    expect(events.indexOf('full-pair')).toBeLessThan(events.indexOf('health'))
    expect(disconnect).not.toHaveBeenCalled()
    handle.releaseAdoptionLease?.()
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('disconnects every temporary client when healthy adoption fails', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const initialDisconnect = vi.fn()
    const replacementDisconnect = vi.fn()
    daemonClientMock
      .mockImplementationOnce(function MockInitialAdoptionClient() {
        return {
          ensureConnected: vi.fn(async () => {
            throw new Error('initial adoption failed')
          }),
          request: vi.fn(),
          disconnect: initialDisconnect
        }
      })
      .mockImplementationOnce(function MockReplacementAdoptionClient() {
        return {
          ensureConnected: vi.fn(async () => {
            throw new Error('replacement adoption failed')
          }),
          request: vi.fn(),
          disconnect: replacementDisconnect
        }
      })
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>

    await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
      'replacement adoption failed'
    )

    expect(initialDisconnect).toHaveBeenCalledOnce()
    expect(replacementDisconnect).toHaveBeenCalledOnce()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('preserves a daemon launched from another app path when it owns live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return {
          sessions: [
            { sessionId: 'wt-1@@live', isAlive: true },
            { sessionId: 'wt-1@@dead', isAlive: false }
          ]
        }
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')

    await launcher('/fake/socket', '/fake/token')

    expect(getDaemonLaunchIdentityMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      FAKE_DAEMON_ENTRY_PATH
    )
    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('preserves a daemon launched from another app path when live session state cannot be verified', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        throw new Error('listSessions failed')
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockReturnValueOnce('mismatch')

    await launcher('/fake/socket', '/fake/token')

    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('respawns instead of reusing a protocol-healthy daemon with broken macOS resolver state', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getMacDaemonSystemResolverHealthMock.mockReturnValueOnce('unhealthy')
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 12345,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          if (event === 'message') {
            queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await launcher('/fake/socket', '/fake/token')

    expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith('/fake/socket', '/fake/token')
    expect(getDaemonLaunchIdentityMock).not.toHaveBeenCalled()
    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalledWith(
      FAKE_DAEMON_ENTRY_PATH,
      expect.arrayContaining([
        '--socket',
        '/fake/socket',
        '--token',
        '/fake/token',
        '--log-file',
        join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log')
      ]),
      expect.objectContaining({ cwd: '/fake/userData', detached: true })
    )
  })

  it('preserves a resolver-unhealthy daemon when it owns live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return {
          sessions: [
            { sessionId: 'wt-1@@live', isAlive: true },
            { sessionId: 'wt-1@@dead', isAlive: false }
          ]
        }
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getMacDaemonSystemResolverHealthMock.mockReturnValueOnce('unhealthy')

    await launcher('/fake/socket', '/fake/token')

    expect(getMacDaemonSystemResolverHealthMock).toHaveBeenCalledWith('/fake/socket', '/fake/token')
    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(getDaemonLaunchIdentityMock).not.toHaveBeenCalled()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('preserves a resolver-unhealthy daemon when live session state cannot be verified', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        throw new Error('listSessions failed')
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getMacDaemonSystemResolverHealthMock.mockReturnValueOnce('unhealthy')

    await launcher('/fake/socket', '/fake/token')

    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('uses the direct daemon entry when Electron app path is already out/main', async () => {
    probeSocketExistsMock.mockImplementation((p?: string) => p === FAKE_DAEMON_ENTRY_PATH)
    const mod = await importFresh()
    getAppPathMock.mockReturnValue(FAKE_APP_OUT_MAIN_PATH)
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 12345,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          if (event === 'message') {
            queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await launcher('/fake/socket', '/fake/token')

    expect(forkMock).toHaveBeenCalledWith(
      FAKE_DAEMON_ENTRY_PATH,
      expect.arrayContaining([
        '--socket',
        '/fake/socket',
        '--token',
        '/fake/token',
        '--log-file',
        join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log')
      ]),
      expect.objectContaining({ detached: true })
    )
  })

  it('removes detached daemon startup listeners after readiness', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const offMock = vi.fn((event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
      return child
    })
    const child = {
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      off: offMock,
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    await launcher('/fake/socket', '/fake/token')

    const launchedArgsWithoutWatch = forkMock.mock.calls.at(-1)?.[1] as string[]
    expect(launchedArgsWithoutWatch).not.toContain('--login-session-watch')

    expect(offMock).toHaveBeenCalledWith('message', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('error', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('exit', expect.any(Function))
    expect(handlers.message).toHaveLength(0)
    expect(handlers.error).toHaveLength(0)
    expect(handlers.exit).toHaveLength(0)
    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
    const [pidPath, pidContents, pidOptions] = writeFileSyncMock.mock.calls.at(-1) ?? []
    expect(pidPath).toBe(`/fake/daemon/daemon-v${PROTOCOL_VERSION}.pid`)
    expect(JSON.parse(pidContents as string)).toEqual({
      pid: 12345,
      startedAtMs: 1_000_000,
      entryPath: FAKE_DAEMON_ENTRY_PATH,
      appVersion: '1.2.3',
      launchNonce: expect.stringMatching(/^[0-9a-f-]{36}$/)
    })
    expect(pidOptions).toEqual({ mode: 0o600, flag: 'wx' })
    const launchArgs = forkMock.mock.calls.at(-1)?.[1] as string[]
    const launchNonceIndex = launchArgs.indexOf('--launch-nonce')
    expect(launchArgs).toEqual(
      expect.arrayContaining([
        '--pid-record',
        `/fake/daemon/daemon-v${PROTOCOL_VERSION}.pid`,
        '--launch-nonce'
      ])
    )
    expect(launchArgs[launchNonceIndex + 1]).toBe(JSON.parse(pidContents as string).launchNonce)
  })

  it('keeps a live PID record after adoption failure and removes it on exact child exit', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()
    const adoptionDisconnects: ReturnType<typeof vi.fn>[] = []
    function MockFailingAdoptionClient() {
      const disconnect = vi.fn()
      adoptionDisconnects.push(disconnect)
      return {
        ensureConnected: vi.fn(async () => {
          throw new Error('adoption unavailable')
        }),
        request: vi.fn(),
        disconnect
      }
    }
    for (let index = 0; index < 3; index++) {
      daemonClientMock.mockImplementationOnce(MockFailingAdoptionClient)
    }
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const child = {
      pid: 12345,
      connected: true,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      on(event: string, callback: (arg?: unknown) => void) {
        handlers[event]?.push(callback)
        if (event === 'message') {
          queueMicrotask(() => callback({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      once(event: string, callback: (arg?: unknown) => void) {
        handlers[event]?.push(callback)
        return this
      },
      off(event: string, callback: (arg?: unknown) => void) {
        handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
        return this
      },
      disconnect: vi.fn(() => {
        child.connected = false
      }),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)
    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string,
      pidPath?: string,
      launchNonce?: string
    ) => Promise<{ shutdown(): Promise<void> }>

    await expect(
      launcher('/fake/socket', '/fake/token', '/fake/daemon.pid', 'launch-delayed')
    ).rejects.toThrow('adoption unavailable')

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      '/fake/daemon.pid',
      expect.stringContaining('launch-delayed'),
      { mode: 0o600, flag: 'wx' }
    )
    expect(unlinkOwnedDaemonPidFileMock).not.toHaveBeenCalled()
    expect(adoptionDisconnects.at(-1)).toHaveBeenCalledOnce()

    child.exitCode = 0
    for (const callback of handlers.exit.slice()) {
      callback(0)
    }
    expect(unlinkOwnedDaemonPidFileMock).toHaveBeenCalledWith(
      '/fake/daemon.pid',
      12345,
      'launch-delayed'
    )
  })

  it('kills and rejects a daemon whose readiness message omits its start time', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('already exited'), { code: 'ESRCH' })
    })
    const child = {
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready' }))
        }
        return this
      },
      off: vi.fn(),
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    try {
      await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow(
        'Daemon readiness identity is incomplete'
      )
      expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM')
      expect(writeFileSyncMock).not.toHaveBeenCalled()
      expect(child.disconnect).not.toHaveBeenCalled()
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
    }
  })

  it('rejects startup cleanup when SIGKILL never produces child exit', async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      const mod = await importFresh()
      checkDaemonHealthMock.mockResolvedValue('unreachable')
      await mod.initDaemonPtyProvider()
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      const child = {
        pid: 12345,
        connected: true,
        exitCode: null,
        signalCode: null,
        on(event: string, callback: (arg?: unknown) => void) {
          handlers[event]?.push(callback)
          if (event === 'message') {
            queueMicrotask(() => callback({ type: 'ready' }))
          }
          return this
        },
        off(event: string, callback: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
          return this
        },
        disconnect: vi.fn(() => {
          child.connected = false
        }),
        unref: vi.fn()
      }
      forkMock.mockReturnValueOnce(child)
      const launcher = spawnerInstances[0].launcher as (
        socketPath: string,
        tokenPath: string
      ) => Promise<{ shutdown(): Promise<void> }>

      const launch = launcher('/fake/socket', '/fake/token')
      await Promise.resolve()
      await Promise.resolve()
      const rejection = expect(launch).rejects.toThrow('startup and child cleanup both failed')
      await vi.advanceTimersByTimeAsync(6_000)
      await rejection

      expect(kill).toHaveBeenNthCalledWith(1, 12345, 'SIGTERM')
      expect(kill).toHaveBeenNthCalledWith(2, 12345, 'SIGKILL')
      expect(child.disconnect).toHaveBeenCalledOnce()
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
      vi.useRealTimers()
    }
  })

  it('surfaces non-ESRCH startup termination errors and releases IPC', async () => {
    const signalError = Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw signalError
    })
    try {
      const mod = await importFresh()
      checkDaemonHealthMock.mockResolvedValue('unreachable')
      await mod.initDaemonPtyProvider()
      const child = {
        pid: 12345,
        connected: true,
        exitCode: null,
        signalCode: null,
        on(event: string, callback: (arg?: unknown) => void) {
          if (event === 'message') {
            queueMicrotask(() => callback({ type: 'ready' }))
          }
          return this
        },
        off: vi.fn(),
        disconnect: vi.fn(() => {
          child.connected = false
        }),
        unref: vi.fn()
      }
      forkMock.mockReturnValueOnce(child)
      const launcher = spawnerInstances[0].launcher as (
        socketPath: string,
        tokenPath: string
      ) => Promise<{ shutdown(): Promise<void> }>

      const error = await launcher('/fake/socket', '/fake/token').catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([
        expect.objectContaining({ message: 'Daemon readiness identity is incomplete' }),
        signalError
      ])
      expect(child.disconnect).toHaveBeenCalledOnce()
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
    }
  })

  it('settles startup with both errors when a malformed-ready child ignores termination', async () => {
    vi.useFakeTimers()
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    try {
      const mod = await importFresh()
      checkDaemonHealthMock.mockResolvedValue('unreachable')
      await mod.initDaemonPtyProvider()
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      const child = {
        pid: 12345,
        connected: true,
        exitCode: null,
        signalCode: null,
        on(event: string, callback: (arg?: unknown) => void) {
          handlers[event]?.push(callback)
          if (event === 'message') {
            queueMicrotask(() => callback({ type: 'ready' }))
          }
          return this
        },
        off(event: string, callback: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
          return this
        },
        disconnect: vi.fn(() => {
          child.connected = false
        }),
        unref: vi.fn()
      }
      forkMock.mockReturnValueOnce(child)
      const launcher = spawnerInstances[0].launcher as (
        socketPath: string,
        tokenPath: string
      ) => Promise<{ shutdown(): Promise<void> }>

      const launch = launcher('/fake/socket', '/fake/token').catch((error: unknown) => error)
      await vi.advanceTimersByTimeAsync(6_000)
      const error = await launch

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).errors).toEqual([
        expect.objectContaining({ message: 'Daemon readiness identity is incomplete' }),
        expect.objectContaining({ message: 'Daemon did not exit after SIGKILL' })
      ])
      expect(kill).toHaveBeenNthCalledWith(1, 12345, 'SIGTERM')
      expect(kill).toHaveBeenNthCalledWith(2, 12345, 'SIGKILL')
      expect(handlers.message).toHaveLength(0)
      expect(handlers.error).toHaveLength(0)
      expect(handlers.exit).toHaveLength(0)
      expect(child.disconnect).toHaveBeenCalledOnce()
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
      vi.useRealTimers()
    }
  })

  it('kills and rejects a daemon when exclusive PID publication fails', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('already exited'), { code: 'ESRCH' })
    })
    const child = {
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      off: vi.fn(),
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    const publicationError = Object.assign(new Error('PID record already exists'), {
      code: 'EEXIST'
    })
    writeFileSyncMock.mockImplementationOnce(() => {
      throw publicationError
    })
    forkMock.mockReturnValueOnce(child)

    try {
      await expect(launcher('/fake/socket', '/fake/token')).rejects.toBe(publicationError)
      expect(writeFileSyncMock).toHaveBeenCalledWith(
        `/fake/daemon/daemon-v${PROTOCOL_VERSION}.pid`,
        expect.any(String),
        { mode: 0o600, flag: 'wx' }
      )
      expect(kill).toHaveBeenCalledWith(12345, 'SIGTERM')
      expect(child.disconnect).not.toHaveBeenCalled()
      expect(child.unref).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
    }
  })

  it('removes detached daemon startup listeners after startup error', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const offMock = vi.fn((event: string, cb: (arg?: unknown) => void) => {
      handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
      return child
    })
    const child = {
      pid: undefined,
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        if (event === 'error') {
          queueMicrotask(() => cb(new Error('startup failed')))
        }
        return this
      },
      off: offMock,
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow('startup failed')

    expect(offMock).toHaveBeenCalledWith('message', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('error', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('exit', expect.any(Function))
    expect(handlers.message).toHaveLength(0)
    expect(handlers.error).toHaveLength(0)
    expect(handlers.exit).toHaveLength(0)
    expect(child.disconnect).not.toHaveBeenCalled()
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('captures daemon startup stderr into the failure error', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const stderrDataCbs: ((chunk: Buffer) => void)[] = []
    const stderrDestroy = vi.fn()
    const stderr = {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data') {
          stderrDataCbs.push(cb)
        }
        return this
      },
      off(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data') {
          const idx = stderrDataCbs.indexOf(cb)
          if (idx !== -1) {
            stderrDataCbs.splice(idx, 1)
          }
        }
        return this
      },
      destroy: stderrDestroy
    }
    const child = {
      pid: 4321,
      exitCode: null as number | null,
      stderr,
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        if (event === 'exit') {
          // Why: deliver the stderr tail before exit so the failure path sees the crash reason (mirrors a module-load crash).
          queueMicrotask(() => {
            for (const dataCb of stderrDataCbs.slice()) {
              dataCb(Buffer.from("Error: Cannot find module 'electron'\n"))
            }
            child.exitCode = 1
            cb(1)
          })
        }
        return this
      },
      off: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
        return child
      }),
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    const error = await launcher('/fake/socket', '/fake/token').catch((err: Error) => err)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/Cannot find module 'electron'/)
    expect((error as Error).message).toMatch(/Daemon stderr \(tail\)/)
    // Why: release the piped stderr so the detached daemon can't keep the parent event loop alive after failure.
    expect(stderrDestroy).toHaveBeenCalled()
  })

  it('destroys the daemon stderr pipe once the daemon signals ready', async () => {
    const mod = await importFresh()
    checkDaemonHealthMock.mockResolvedValue('unreachable')
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    const handlers: Record<string, ((arg?: unknown) => void)[]> = {
      message: [],
      error: [],
      exit: []
    }
    const stderrOff = vi.fn()
    const stderrDestroy = vi.fn()
    const stderr = {
      on() {
        return this
      },
      off: stderrOff,
      destroy: stderrDestroy
    }
    const child = {
      pid: 12345,
      stderr,
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      once(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        return this
      },
      off: vi.fn(() => child),
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    await launcher('/fake/socket', '/fake/token')

    expect(stderrOff).toHaveBeenCalledWith('data', expect.any(Function))
    expect(stderrDestroy).toHaveBeenCalledOnce()
    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
  })

  it('preserves a health-check-failing daemon when it owns live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return {
          sessions: [{ sessionId: 'wt-1@@live', isAlive: true }]
        }
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')

    await launcher('/fake/socket', '/fake/token')

    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('marks a preserved daemon as degraded when its PTY spawn health check fails', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return {
          sessions: [{ sessionId: 'wt-1@@live', isAlive: true }]
        }
      }
      return {}
    })
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: vi.fn()
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ mode?: 'degraded-new-pty-fallback'; shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('pty-spawn-unhealthy')

    const handle = await launcher('/fake/socket', '/fake/token')

    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(handle.mode).toBe('degraded-new-pty-fallback')
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('replaces a health-check-failing daemon when live sessions cannot be verified and the pipe is dead', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {
          throw new Error('daemon is wedged')
        }),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')
    forkMock.mockImplementationOnce(() => ({
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
        }
        return this
      },
      once() {
        return this
      },
      off() {
        return this
      },
      disconnect: vi.fn(),
      unref: vi.fn()
    }))

    await launcher('/fake/socket', '/fake/token')

    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalled()
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
        request: vi.fn(async () => ({ sessions: [{ sessionId: 'wt-1@@live', isAlive: true }] })),
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
    } finally {
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

  it('adopts a healthy daemon whose pid-file identity cannot be verified (null startedAtMs metadata)', async () => {
    // Why: startedAtMs null (all pre-fix Windows pid files) → identity 'unknown'; a live daemon must ADOPT, not replace.
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

  it('writes the daemon self-reported start time to the pid file when the OS query returns null', async () => {
    // Why: getProcessStartedAtMs has no cheap Windows impl, so the pid-recycling guard uses the ready-message fallback.
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')
    getProcessStartedAtMsMock.mockReturnValue(null)
    forkMock.mockImplementationOnce(() => ({
      pid: 12345,
      on(event: string, cb: (arg?: unknown) => void) {
        if (event === 'message') {
          queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_700_000_123_456 }))
        }
        return this
      },
      off() {
        return this
      },
      disconnect: vi.fn(),
      unref: vi.fn()
    }))

    await launcher('/fake/socket', '/fake/token')

    const [pidPath, pidContents, pidOptions] = writeFileSyncMock.mock.calls.at(-1) ?? []
    expect(pidPath).toBe(`/fake/daemon/daemon-v${PROTOCOL_VERSION}.pid`)
    expect(JSON.parse(pidContents as string)).toEqual({
      pid: 12345,
      startedAtMs: 1_700_000_123_456,
      entryPath: FAKE_DAEMON_ENTRY_PATH,
      appVersion: '1.2.3',
      launchNonce: expect.stringMatching(/^[0-9a-f-]{36}$/)
    })
    expect(pidOptions).toEqual({ mode: 0o600, flag: 'wx' })
  })

  it('keeps legacy daemon pid/token files when the probe fails but the pid-file process is alive', async () => {
    // Why: deleting a live legacy daemon's token file makes its sessions permanently unadoptable.
    const mod = await importFresh()
    readFileSyncMock.mockReturnValue('{"pid":123}')
    // process.pid is guaranteed alive, so the liveness probe succeeds.
    parseDaemonPidFileMock.mockReturnValue({ pid: process.pid, startedAtMs: null })

    await mod.initDaemonPtyProvider()

    const legacyUnlinks = unlinkSyncMock.mock.calls.filter(
      ([p]) => typeof p === 'string' && (p.includes('.token') || p.includes('.pid'))
    )
    expect(legacyUnlinks).toEqual([])
  })

  it('cleans up legacy daemon pid/token files when the probe fails and the process is gone', async () => {
    const mod = await importFresh()
    readFileSyncMock.mockReturnValue('{"pid":123}')
    // Why: spy process.kill to force a deterministic ESRCH instead of relying on an unallocated real pid.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('ESRCH')
    })
    parseDaemonPidFileMock.mockReturnValue({ pid: 999_999, startedAtMs: null })

    try {
      await mod.initDaemonPtyProvider()
    } finally {
      killSpy.mockRestore()
    }

    const tokenUnlinks = unlinkSyncMock.mock.calls.filter(
      ([p]) => typeof p === 'string' && p.includes('.token')
    )
    expect(tokenUnlinks.length).toBeGreaterThan(0)
  })

  it('replaces a health-check-failing daemon when no live sessions would be lost', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    checkDaemonHealthMock.mockResolvedValueOnce('unreachable')
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 12345,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          if (event === 'message') {
            queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await launcher('/fake/socket', '/fake/token')

    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalledWith(
      FAKE_DAEMON_ENTRY_PATH,
      expect.arrayContaining([
        '--socket',
        '/fake/socket',
        '--token',
        '/fake/token',
        '--log-file',
        join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log')
      ]),
      expect.objectContaining({ detached: true })
    )
  })

  it('preserves a packaged healthy daemon when its app bundle is current', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    getDaemonLaunchIdentityMock.mockClear()
    killStaleDaemonMock.mockClear()
    forkMock.mockClear()
    isPackagedMock.mockReturnValue(true)

    await launcher('/fake/socket', '/fake/token')

    expect(getDaemonLaunchIdentityMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      FAKE_DAEMON_ENTRY_PATH
    )
    expect(isDaemonStaleForCurrentBundleMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      '1.2.3'
    )
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('respawns a packaged daemon that predates the current app bundle', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    isPackagedMock.mockReturnValue(true)
    isDaemonStaleForCurrentBundleMock.mockReturnValueOnce(true)
    forkMock.mockImplementationOnce(() => {
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {
        message: [],
        error: [],
        exit: []
      }
      return {
        pid: 12345,
        on(event: string, cb: (arg?: unknown) => void) {
          handlers[event]?.push(cb)
          if (event === 'message') {
            queueMicrotask(() => cb({ type: 'ready', startedAtMs: 1_000_000 }))
          }
          return this
        },
        off(event: string, cb: (arg?: unknown) => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== cb) ?? []
          return this
        },
        disconnect: vi.fn(),
        unref: vi.fn()
      }
    })

    await launcher('/fake/socket', '/fake/token')

    expect(isDaemonStaleForCurrentBundleMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      '1.2.3'
    )
    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalledWith(
      FAKE_DAEMON_ENTRY_PATH,
      expect.arrayContaining([
        '--socket',
        '/fake/socket',
        '--token',
        '/fake/token',
        '--log-file',
        join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log')
      ]),
      expect.objectContaining({ detached: true })
    )
  })

  it('preserves a packaged daemon that predates the current app bundle when it owns live sessions', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return {
          sessions: [{ sessionId: 'wt-1@@live', isAlive: true }]
        }
      }
      return {}
    })
    const disconnectMock = vi.fn()
    mockConnectedAdoptionClientOnce()
    daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const launcher = spawnerInstances[0].launcher as (
      socketPath: string,
      tokenPath: string
    ) => Promise<{ shutdown(): Promise<void> }>
    isPackagedMock.mockReturnValue(true)
    isDaemonStaleForCurrentBundleMock.mockReturnValueOnce(true)

    await launcher('/fake/socket', '/fake/token')

    expect(isDaemonStaleForCurrentBundleMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token',
      '1.2.3'
    )
    expect(requestMock).toHaveBeenCalledWith('listSessions', undefined)
    expect(disconnectMock).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })
})
