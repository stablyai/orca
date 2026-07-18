/* eslint-disable max-lines -- Why: this file covers the entire restart flow
   of daemon-init — construction, the 7-step sequence from
   docs/daemon-staleness-ux.md §Phase 1, and the concurrency coalescer. A
   single describe block with shared mocks keeps setup in one place; splitting
   across files would duplicate the vi.hoisted boundary mocks with no cleaner
   ownership seam. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from './types'
import { WEDGED_DAEMON_GRACE_RETRIES } from './daemon-init'

const FAKE_USER_DATA_PATH = '/fake/userData'
const FAKE_RUNTIME_DIR = join(FAKE_USER_DATA_PATH, 'daemon')
const FAKE_APP_PATH = '/fake/app'
const FAKE_APP_OUT_MAIN_PATH = join(FAKE_APP_PATH, 'out', 'main')
const FAKE_DAEMON_ENTRY_PATH = join(FAKE_APP_OUT_MAIN_PATH, 'daemon-entry.js')

// Why: the restart flow touches many boundary modules (electron app paths, fs
// for dir creation, net for socket probe, DaemonClient over that socket, the
// spawner's launcher, ipc/pty listener binders). We only care here about the
// observable sequencing and identity invariants of runRestartDaemon, so every
// non-daemon-init dependency is replaced by a minimal stub that records calls.
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
  daemonClientMock,
  spawnerInstances,
  ensureRunningOverrides,
  adapterInstances,
  defaultListSessionsSessions,
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
  // Why: readFileSync throws by default so legacyDaemonProcessMayBeAlive's
  // catch treats every legacy pid file as unreadable — matching the pre-fix
  // cleanup behavior every existing test was written against.
  const readFileSyncMock = vi.fn((): string => {
    throw new Error('ENOENT')
  })
  const unlinkSyncMock = vi.fn()
  const forkMock = vi.fn()
  const netConnectMock = vi.fn(() => {
    // Why: the real probeSocket() in daemon-init connects to the socket and
    // resolves true on 'connect', false on 'error'. Our launcher never runs
    // in these tests (healthCheckDaemon short-circuits), but probeSocket is
    // also invoked by cleanupDaemonForProtocol — stub the socket object so
    // the 'error' path fires synchronously and cleanupDaemonForProtocol's
    // alive=false branch runs without side effects.
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

  const daemonClientMock = vi.fn().mockImplementation(function MockDaemonClient() {
    return {
      ensureConnected: vi.fn(async () => {}),
      request: vi.fn(async () => ({ sessions: [] })),
      disconnect: vi.fn()
    }
  })

  // Why: every DaemonSpawner constructed under test pushes into this array so
  // assertions can check "was the *same* spawner reused across restart?".
  const spawnerInstances: MockSpawner[] = []
  const ensureRunningOverrides: (() => Promise<{
    socketPath: string
    tokenPath: string
    mode?: 'degraded-new-pty-fallback'
  }>)[] = []
  // Same for DaemonPtyAdapter. The test asserts the replacement adapter is a
  // fresh instance whose respawn closure targets the *original* spawner.
  const adapterInstances: MockAdapter[] = []
  // Why: adapters are constructed inside initDaemonPtyProvider, so tests that
  // need listSessions to report live sessions set this before calling init.
  const defaultListSessionsSessions: { sessionId: string }[] = []

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
    daemonClientMock,
    spawnerInstances,
    ensureRunningOverrides,
    adapterInstances,
    defaultListSessionsSessions,
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
  shutdown: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  disconnectOnly: ReturnType<typeof vi.fn>
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  // Why: MockAdapter is fed through `new DaemonPtyRouter({ current, legacy })`
  // during the "legacy preservation" test. The real router calls onData/onExit
  // on each adapter; our stub returns a no-op unsubscribe so the router can
  // subscribe without exploding.
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
    private handle: { mode?: 'degraded-new-pty-fallback'; shutdown: () => Promise<void> } | null
    constructor(opts: { runtimeDir: string; launcher: unknown }) {
      this.launcher = opts.launcher
      this.socketCounter = 0
      this.handle = null
      // Why: each ensureRunning bumps a counter into the returned socketPath
      // so the test can verify the *replacement* adapter is constructed with
      // info from the second ensureRunning call, not stale info from the first.
      this.ensureRunning = vi.fn(async () => {
        const override = ensureRunningOverrides.shift()
        if (override) {
          const result = await override()
          this.handle = { shutdown: vi.fn(async () => {}) }
          if (result.mode) {
            this.handle.mode = result.mode
          }
          return {
            socketPath: result.socketPath,
            tokenPath: result.tokenPath
          }
        }
        this.socketCounter += 1
        this.handle = { shutdown: vi.fn(async () => {}) }
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
  serializeDaemonPidFile: (obj: unknown) => JSON.stringify(obj)
}))

vi.mock('./daemon-pty-adapter', () => ({
  DaemonPtyAdapter: class MockDaemonPtyAdapter {
    readonly protocolVersion: number
    readonly options: MockAdapter['options']
    readonly getActiveSessionIds: ReturnType<typeof vi.fn>
    readonly fanoutSyntheticExits: ReturnType<typeof vi.fn>
    readonly listProcesses: ReturnType<typeof vi.fn>
    readonly listSessions: ReturnType<typeof vi.fn>
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
      this.listProcesses = vi.fn(async () => [])
      this.listSessions = vi.fn(async () => [...defaultListSessionsSessions])
      this.shutdown = vi.fn(async () => {})
      this.dispose = vi.fn()
      this.disconnectOnly = vi.fn(async () => {})
      this.onData = vi.fn(() => () => {})
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
  adapterInstances.length = 0
  defaultListSessionsSessions.length = 0
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
  daemonClientMock.mockClear()
  probeSocketExistsMock.mockClear()
  writeFileSyncMock.mockClear()
  readFileSyncMock.mockReset()
  readFileSyncMock.mockImplementation(() => {
    throw new Error('ENOENT')
  })
  unlinkSyncMock.mockClear()
  parseDaemonPidFileMock.mockReset()
  parseDaemonPidFileMock.mockReturnValue(null)
  getProcessStartedAtMsMock.mockReset()
  getProcessStartedAtMsMock.mockReturnValue(1_000_000)
  // Why: importing daemon-init *after* resetModules means the module-level
  // `spawner`/`adapter`/`restartInFlight` start fresh for every test, which is
  // the only way to reliably exercise the "first-time init" path and the
  // coalescer independently.
  return import('./daemon-init')
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
  })

  it('prunes seeded Claude live-PTY ids against daemon sessions after init', async () => {
    const mod = await importFresh()
    // Why: live-pty-gate is intentionally unmocked — import from the same fresh
    // module registry so the module-level gate state matches daemon-init's.
    const gate = await import('../claude-accounts/live-pty-gate')
    defaultListSessionsSessions.push({ sessionId: 'claude-alive' })
    gate.seedLiveClaudePtysFromPersistence(['claude-alive', 'claude-dead'])
    try {
      await mod.initDaemonPtyProvider()

      expect(gate.hasLiveClaudePtys()).toBe(true)

      gate.markClaudePtyExited('claude-alive')
      // Why: proves 'claude-dead' was released by the daemon reconcile — the
      // surviving session was the only id still holding the gate.
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

    expect(adapterInstances).toHaveLength(0)
    expect(setLocalPtyProviderMock).not.toHaveBeenCalled()
    expect(rebindLocalProviderListenersMock).not.toHaveBeenCalled()
    expect(mod.getDaemonProvider()).toBeNull()
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

    // Why: seed the original adapter with active sessions so
    // fanoutSyntheticExits has something to do. The real adapter snapshots
    // activeSessionIds then clears it; the mock emulates that so a regression
    // that measures killedCount *after* fanout (when the set is empty) would
    // surface as `killedCount === 0` here.
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

    // killedCount must be 3 — proves the count was taken *before* the fanout
    // cleared the set. A bug that swapped these two lines in source would
    // report 0 here.
    expect(result.killedCount).toBe(3)
    expect(originalAdapter.fanoutSyntheticExits).toHaveBeenCalledWith(-1)
    // The load-bearing ordering invariant: the synthetic exits must reach
    // the renderer *before* listeners are torn down. Step 1 before Step 2.
    expect(order).toEqual(['fanout', 'unbind'])
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

    // Invoking the replacement adapter's respawn closure must drive the
    // *same* original spawner (matches the crash-respawn closure baked into
    // the first adapter — see daemon-init.ts step 5 comment).
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

    // Step 7: rebind must run *after* Step 6. The last rebind call index
    // must be greater than the last setLocalPtyProvider call index.
    const rebindOrder = rebindLocalProviderListenersMock.mock.invocationCallOrder.at(-1) ?? -1
    const swapOrder = setLocalPtyProviderMock.mock.invocationCallOrder.at(-1) ?? -1
    expect(rebindOrder).toBeGreaterThan(swapOrder)
  })

  it('preserves legacy adapter instances by identity, drains outgoing router via disposeRouterOnly, and re-discovers legacy sessions on the new router', async () => {
    const mod = await importFresh()

    // Why: initDaemonPtyProvider only constructs legacy adapters when
    // probeSocket returns true for a legacy socket path. The real flow runs
    // createLegacyDaemonAdapters which calls probeSocket per previous version.
    // Simplest seam for this test: directly construct a router with a legacy
    // adapter and install it via replaceDaemonProvider, bypassing
    // createLegacyDaemonAdapters' socket-probe machinery.
    await mod.initDaemonPtyProvider()

    const { DaemonPtyRouter } = await import('./daemon-pty-router')
    const { DaemonPtyAdapter } = await import('./daemon-pty-adapter')
    const currentAtConstruction = adapterInstances[0]
    // Construct a legacy adapter using the mocked constructor (pushes into
    // adapterInstances) — index 1.
    const legacyAdapter = new DaemonPtyAdapter({
      socketPath: '/fake/legacy.sock',
      tokenPath: '/fake/legacy.token',
      protocolVersion: 3
    })
    const routerWithLegacy = new DaemonPtyRouter({
      current: currentAtConstruction as unknown as InstanceType<typeof DaemonPtyAdapter>,
      legacy: [legacyAdapter as unknown as InstanceType<typeof DaemonPtyAdapter>]
    })
    // Why: spy on the *outgoing* router's disposeRouterOnly so we can prove it
    // was invoked (not just that legacy adapters survived — a no-op
    // disposeRouterOnly would leak listeners but still leave adapters alive).
    const disposeRouterOnlySpy = vi.spyOn(routerWithLegacy, 'disposeRouterOnly')
    const oldRouterDispose = vi.spyOn(routerWithLegacy, 'dispose')
    mod.replaceDaemonProvider(routerWithLegacy)

    await mod.restartDaemon()

    const provider = mod.getDaemonProvider()
    expect(provider).toBeInstanceOf(DaemonPtyRouter)
    const newRouter = provider as InstanceType<typeof DaemonPtyRouter>
    expect(newRouter).not.toBe(routerWithLegacy)

    // Legacy adapter instance is preserved by identity — not reconstructed,
    // not defensively copied, not disposed.
    const legacies = newRouter.getLegacyAdapters()
    expect(legacies).toHaveLength(1)
    expect(legacies[0]).toBe(legacyAdapter)
    expect(legacyAdapter.dispose).not.toHaveBeenCalled()
    // The outgoing router was drained via disposeRouterOnly (router-only
    // teardown), so legacy adapters' underlying connections are untouched.
    expect(legacyAdapter.disconnectOnly).not.toHaveBeenCalled()
    // The outgoing router's subscriptions were drained but the adapters
    // behind it were NOT disposed — that's the whole point of disposeRouterOnly.
    expect(disposeRouterOnlySpy).toHaveBeenCalledTimes(1)
    expect(oldRouterDispose).not.toHaveBeenCalled()

    // The replacement router must re-run discovery so spawns targeting a
    // surviving legacy sessionId still route to the legacy adapter.
    expect(legacyAdapter.listProcesses).toHaveBeenCalled()
  })

  it('routes affected v9 daemon sessions through a legacy adapter on launch', async () => {
    const mod = await importFresh()
    probeSocketExistsMock.mockImplementation((p?: string) => p?.endsWith('daemon-v9.sock') ?? false)
    netConnectMock.mockImplementation(() => {
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

    await mod.initDaemonPtyProvider()

    const { DaemonPtyRouter } = await import('./daemon-pty-router')
    expect(mod.getDaemonProvider()).toBeInstanceOf(DaemonPtyRouter)
    expect(adapterInstances.some((instance) => instance.protocolVersion === 9)).toBe(true)
  })

  it('restart path with no legacy adapters yields a bare DaemonPtyAdapter (not wrapped in a router)', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // initDaemonPtyProvider sets up a bare adapter when createLegacyDaemonAdapters
    // finds nothing — confirm that shape persists across restart.
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

    // Build an ordered trace by stamping each step as it fires. Cleanup is
    // the tricky one — it's the `cleanupDaemonForProtocol` call, observable
    // via the probeSocket→healthCheckDaemon→killStaleDaemon branch. We use
    // healthCheckDaemon as the cleanup-start marker because it's the first
    // call inside createOutOfProcessLauncher → and also fires inside
    // cleanupDaemonForProtocol's alive branch… actually in the default
    // (probeSocket=false) path cleanup is a no-op beyond pid-unlink. The
    // load-bearing observable is `resetHandle` — it fires *after* cleanup
    // returns. So we instrument the spawner instead.
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

    // The full 7-step sequence in order. Step 3 (cleanupDaemonForProtocol)
    // has no unique observable in the dead-socket branch, so it's implicitly
    // ordered by the fact that resetHandle runs after unbind; if cleanup
    // ever moved *after* resetHandle, we'd see `resetHandle` precede its
    // expected position.
    expect(trace).toEqual([
      'fanout',
      'unbind',
      'resetHandle',
      'ensureRunning',
      'replaceProvider',
      'rebind'
    ])

    // A fresh adapter must have been constructed *between* ensureRunning
    // and replaceProvider (Step 5 before Step 6). adapterInstances[1] is
    // the replacement — its socketPath comes from the Step-4 ensureRunning
    // result, so its existence proves the ordering.
    expect(adapterInstances).toHaveLength(2)
    expect(adapterInstances[1].options.socketPath).toBe('/fake/socket-2')
  })

  it('exercises the alive-daemon cleanup path: issues shutdown RPC via DaemonClient before spawning a replacement', async () => {
    // Why: the default mock has probeSocket returning false, so Step 3's
    // DaemonClient-based shutdown path is normally skipped. This test flips
    // the socket to "alive" so cleanupDaemonForProtocol takes the
    // client.ensureConnected → listSessions → shutdown RPC branch. Without
    // this, the design doc's Risks section ("verify under both 'shutdown
    // RPC succeeded' and 'fell back to killStaleDaemon' paths") is uncovered.

    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return { sessions: [{ sessionId: 'live-1', isAlive: true }] }
      }
      // `shutdown` RPC — daemon exits before reply lands; return undefined.
      return undefined
    })
    const ensureConnectedMock = vi.fn(async () => {})
    const disconnectMock = vi.fn()
    // Why: DaemonClient is invoked via `new DaemonClient(...)`, so the mock
    // factory must return a constructor-compatible function. Capture the
    // existing impl so later tests aren't affected.
    daemonClientMock.mockImplementationOnce(function MockDaemonClientForShutdown() {
      return {
        ensureConnected: ensureConnectedMock,
        request: requestMock,
        disconnect: disconnectMock
      }
    })

    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // Make probeSocket return true for the current-version path by toggling
    // both the fs.existsSync proxy AND net.connect resolving "alive".
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

    // Why: without an explicit gate, `Promise.all([restartDaemon(),
    // restartDaemon()])` evaluates arguments left-to-right *synchronously* —
    // the first call's promise could resolve before the second invocation
    // begins if all internal awaits resolved in a single microtask, which
    // would leave the coalescer untested. The deferred gate holds the first
    // restart inside `ensureRunning` until we release it, guaranteeing the
    // second call enters while the first is genuinely mid-flight.
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

    // Why: `async function restartDaemon` wraps each return in a fresh
    // Promise, so `call1 === call2` does *not* hold even when the coalescer
    // is working. The load-bearing proof is behavioral: while call1 is
    // blocked on the ensureRunning barrier, call2 must NOT fork a parallel
    // run of the 7-step sequence. If the coalescer fails, a second
    // `runRestartDaemon` starts, which means a second `resetHandle` fires
    // before we release the barrier. Check that counter at this exact
    // moment — a non-coalescing implementation would already be at 2.
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(adapterInstances).toHaveLength(1)

    releaseEnsureRunning?.()
    const [r1, r2] = await Promise.all([call1, call2])
    // Both resolved values must be structurally identical (same result
    // object bubbled up through the shared runRestartDaemon promise).
    expect(r1).toEqual(r2)

    // resetHandle fires once per restart; ensureRunning fires once during
    // init + once during restart. A second, un-coalesced restart would push
    // these counters to 2 and 3 respectively.
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(originalSpawner.ensureRunning).toHaveBeenCalledTimes(2)
    expect(adapterInstances).toHaveLength(2)

    // After the in-flight promise settles, a fresh restart is allowed to run
    // — proves `.finally(() => restartInFlight = null)` actually cleared the
    // slot. A stale restartInFlight would skip the work entirely.
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
    await mod.initDaemonPtyProvider()

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
            queueMicrotask(() => cb({ type: 'ready' }))
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
        '--log-file',
        join(FAKE_USER_DATA_PATH, 'logs', 'daemon.log')
      ]),
      expect.objectContaining({ cwd: '/fake/userData', detached: true })
    )
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
            queueMicrotask(() => cb({ type: 'ready' }))
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
            queueMicrotask(() => cb({ type: 'ready' }))
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
          queueMicrotask(() => cb({ type: 'ready' }))
        }
        return this
      },
      off: offMock,
      disconnect: vi.fn(),
      unref: vi.fn()
    }
    forkMock.mockReturnValueOnce(child)

    await launcher('/fake/socket', '/fake/token')

    expect(offMock).toHaveBeenCalledWith('message', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('error', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('exit', expect.any(Function))
    expect(handlers.message).toHaveLength(0)
    expect(handlers.error).toHaveLength(0)
    expect(handlers.exit).toHaveLength(0)
    expect(child.disconnect).toHaveBeenCalledOnce()
    expect(child.unref).toHaveBeenCalledOnce()
    expect(writeFileSyncMock).toHaveBeenCalledWith(
      `/fake/daemon/daemon-v${PROTOCOL_VERSION}.pid`,
      JSON.stringify({
        pid: 12345,
        startedAtMs: 1_000_000,
        entryPath: FAKE_DAEMON_ENTRY_PATH,
        appVersion: '1.2.3'
      }),
      { mode: 0o600 }
    )
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
    expect(child.unref).not.toHaveBeenCalled()
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
      stderr,
      on(event: string, cb: (arg?: unknown) => void) {
        handlers[event]?.push(cb)
        if (event === 'exit') {
          // Why: deliver the stderr tail before the exit so the failure path
          // sees the captured crash reason, mirroring a module-load crash.
          queueMicrotask(() => {
            for (const dataCb of stderrDataCbs.slice()) {
              dataCb(Buffer.from("Error: Cannot find module 'electron'\n"))
            }
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
    // Why: the piped stderr must be released so the detached daemon does not
    // keep the parent event loop alive after the failure.
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
          queueMicrotask(() => cb({ type: 'ready' }))
        }
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
          queueMicrotask(() => cb({ type: 'ready' }))
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

    expect(killStaleDaemonMock).toHaveBeenCalledWith(
      FAKE_RUNTIME_DIR,
      '/fake/socket',
      '/fake/token'
    )
    expect(forkMock).toHaveBeenCalled()
  })

  // Why: a net.connect stub whose 'connect' fires — makes probeSocket() report
  // the wedged daemon's pipe as alive on every grace re-check.
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
    // Why: the Windows update-relaunch case — post-install disk/AV load wedges
    // the daemon past the first hello budget, but it drains within seconds and
    // still owns live sessions. The launcher must give it a bounded grace and
    // ADOPT it rather than killing its live sessions.
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // First probe times out (still draining); the retry within the grace
    // window succeeds and reports a live session.
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
    // Why: a daemon whose socket keeps accepting connections but whose event
    // loop never answers hello would, under the old code, be preserved forever
    // — every terminal spawn then failed with "Hello response timed out" with
    // no recovery. After the bounded grace it must be replaced so the app gets
    // working terminals again.
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const answeringDefault = function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: vi.fn(async () => ({ sessions: [] })),
        disconnect: vi.fn()
      }
    }
    // Every probe across the whole grace window times out (permanent wedge).
    daemonClientMock.mockImplementation(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {
          throw new Error('Hello response timed out')
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
          queueMicrotask(() => cb({ type: 'ready' }))
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
      // The launcher probes the full grace budget before giving up: 1 initial
      // probe + WEDGED_DAEMON_GRACE_RETRIES retries.
      expect(daemonClientMock).toHaveBeenCalledTimes(1 + WEDGED_DAEMON_GRACE_RETRIES)
    } finally {
      // Restore the answering default so the persistent throwing impl above
      // does not leak into later tests (clearAllMocks clears calls, not impls).
      daemonClientMock.mockImplementation(answeringDefault)
    }
  })

  it('grace budget is generous enough to ride out a ~60s transient wedge', () => {
    // Why: pins the magnitude. Each probe waits out the client's 5s hello
    // timeout, so 1 + 11 probes ≈ 60s of drain grace. Shrinking this narrows
    // the window in which a transiently wedged daemon's live sessions are
    // preserved instead of replaced — don't cut it without field telemetry.
    expect(WEDGED_DAEMON_GRACE_RETRIES).toBeGreaterThanOrEqual(11)
  })

  it('preserves a daemon that stays wedged until the LAST allowed grace retry', async () => {
    // Why: exercises the full grace loop end-to-end. The daemon throws on every
    // probe except the final allowed one (1 + WEDGED_DAEMON_GRACE_RETRIES), on
    // which it drains and reports a live session — so it must be preserved, not
    // replaced. Cutting the retry budget below the drain point would replace a
    // still-live daemon, which this test catches.
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
    // Why: 'rejected' means the daemon answered and refused the handshake —
    // it can never be adopted, so keeping it alive would strand the app with
    // no terminals forever. Replacement stays the only recovery.
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
          queueMicrotask(() => cb({ type: 'ready' }))
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
    // Pins the 'rejected' fast-path: a daemon that actively refuses the
    // handshake is never worth a grace window, so it is probed exactly once
    // (no retries) before replacement.
    expect(daemonClientMock).toHaveBeenCalledTimes(1)
  })

  it('adopts a healthy daemon whose pid-file identity cannot be verified (null startedAtMs metadata)', async () => {
    // Why: the regression contract — a pid file with startedAtMs null (all
    // pre-fix Windows pid files) resolves launch identity to 'unknown'. With
    // a live daemon answering on the pipe, that must ADOPT, never replace.
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
    // Why: getProcessStartedAtMs has no cheap Windows implementation, so the
    // pid file's pid-recycling guard depends on the ready-message fallback.
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

    expect(writeFileSyncMock).toHaveBeenCalledWith(
      `/fake/daemon/daemon-v${PROTOCOL_VERSION}.pid`,
      JSON.stringify({
        pid: 12345,
        startedAtMs: 1_700_000_123_456,
        entryPath: FAKE_DAEMON_ENTRY_PATH,
        appVersion: '1.2.3'
      }),
      { mode: 0o600 }
    )
  })

  it('keeps legacy daemon pid/token files when the probe fails but the pid-file process is alive', async () => {
    // Why: deleting a live-but-wedged legacy daemon's token file makes its
    // sessions permanently unadoptable — no future launch could authenticate.
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
    // Why: spy on process.kill so the liveness probe deterministically reports
    // "no such process" without depending on an unallocated real pid.
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
            queueMicrotask(() => cb({ type: 'ready' }))
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
            queueMicrotask(() => cb({ type: 'ready' }))
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
