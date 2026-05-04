/* eslint-disable max-lines -- Why: this file covers the entire restart flow
   of daemon-init — construction, the 7-step sequence from
   docs/daemon-staleness-ux.md §Phase 1, and the concurrency coalescer. A
   single describe block with shared mocks keeps setup in one place; splitting
   across files would duplicate the vi.hoisted boundary mocks with no cleaner
   ownership seam. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from './types'

// Why: the restart flow touches many boundary modules (electron app paths, fs
// for dir creation, net for socket probe, DaemonClient over that socket, the
// spawner's launcher, ipc/pty listener binders). We only care here about the
// observable sequencing and identity invariants of runRestartDaemon, so every
// non-daemon-init dependency is replaced by a minimal stub that records calls.
const {
  getPathMock,
  probeSocketExistsMock,
  netConnectMock,
  healthCheckDaemonMock,
  killStaleDaemonMock,
  getProcessStartedAtMsMock,
  daemonClientMock,
  spawnerInstances,
  adapterInstances,
  setLocalPtyProviderMock,
  unbindLocalProviderListenersMock,
  rebindLocalProviderListenersMock
} = vi.hoisted(() => {
  const getPathMock = vi.fn(() => '/fake/userData')

  const probeSocketExistsMock = vi.fn(() => false)
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
      destroy() {}
    }
  })

  const healthCheckDaemonMock = vi.fn(async () => true)
  const killStaleDaemonMock = vi.fn(async () => true)
  const getProcessStartedAtMsMock = vi.fn(() => 1_000_000)

  const daemonClientMock = vi.fn().mockImplementation(() => ({
    ensureConnected: vi.fn(async () => {}),
    request: vi.fn(async () => ({ sessions: [] })),
    disconnect: vi.fn()
  }))

  // Why: every DaemonSpawner constructed under test pushes into this array so
  // assertions can check "was the *same* spawner reused across restart?".
  const spawnerInstances: MockSpawner[] = []
  // Same for DaemonPtyAdapter. The test asserts the replacement adapter is a
  // fresh instance whose respawn closure targets the *original* spawner.
  const adapterInstances: MockAdapter[] = []

  const setLocalPtyProviderMock = vi.fn()
  const unbindLocalProviderListenersMock = vi.fn()
  const rebindLocalProviderListenersMock = vi.fn()

  return {
    getPathMock,
    probeSocketExistsMock,
    netConnectMock,
    healthCheckDaemonMock,
    killStaleDaemonMock,
    getProcessStartedAtMsMock,
    daemonClientMock,
    spawnerInstances,
    adapterInstances,
    setLocalPtyProviderMock,
    unbindLocalProviderListenersMock,
    rebindLocalProviderListenersMock
  }
})

type MockSpawner = {
  ensureRunning: ReturnType<typeof vi.fn>
  resetHandle: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
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
  app: { getPath: getPathMock, getAppPath: () => '/fake/app' }
}))

vi.mock('fs', () => ({
  mkdirSync: vi.fn(),
  existsSync: (p: string) => probeSocketExistsMock() || p.includes('.pid'),
  unlinkSync: vi.fn(),
  writeFileSync: vi.fn()
}))

vi.mock('child_process', () => ({ fork: vi.fn() }))

vi.mock('net', () => ({ connect: netConnectMock }))

vi.mock('./daemon-health', () => ({
  healthCheckDaemon: healthCheckDaemonMock,
  killStaleDaemon: killStaleDaemonMock,
  getProcessStartedAtMs: getProcessStartedAtMsMock
}))

vi.mock('./client', () => ({ DaemonClient: daemonClientMock }))

vi.mock('./daemon-spawner', () => ({
  DaemonSpawner: class MockDaemonSpawner {
    readonly launcher: unknown
    readonly ensureRunning: ReturnType<typeof vi.fn>
    readonly resetHandle: ReturnType<typeof vi.fn>
    readonly shutdown: ReturnType<typeof vi.fn>
    private socketCounter: number
    constructor(opts: { runtimeDir: string; launcher: unknown }) {
      this.launcher = opts.launcher
      this.socketCounter = 0
      // Why: each ensureRunning bumps a counter into the returned socketPath
      // so the test can verify the *replacement* adapter is constructed with
      // info from the second ensureRunning call, not stale info from the first.
      this.ensureRunning = vi.fn(async () => {
        this.socketCounter += 1
        return {
          socketPath: `/fake/socket-${this.socketCounter}`,
          tokenPath: `/fake/token-${this.socketCounter}`
        }
      })
      this.resetHandle = vi.fn()
      this.shutdown = vi.fn(async () => {})
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
      this.listSessions = vi.fn(async () => [])
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
  setLocalPtyProvider: setLocalPtyProviderMock,
  unbindLocalProviderListeners: unbindLocalProviderListenersMock,
  rebindLocalProviderListeners: rebindLocalProviderListenersMock
}))

async function importFresh() {
  vi.resetModules()
  spawnerInstances.length = 0
  adapterInstances.length = 0
  setLocalPtyProviderMock.mockClear()
  unbindLocalProviderListenersMock.mockClear()
  rebindLocalProviderListenersMock.mockClear()
  healthCheckDaemonMock.mockClear()
  killStaleDaemonMock.mockClear()
  daemonClientMock.mockClear()
  probeSocketExistsMock.mockClear()
  // Why: importing daemon-init *after* resetModules means the module-level
  // `spawner`/`adapter`/`restartInFlight` start fresh for every test, which is
  // the only way to reliably exercise the "first-time init" path and the
  // coalescer independently.
  return import('./daemon-init')
}

describe('daemon-init: runRestartDaemon (7-step sequence)', () => {
  beforeEach(() => {
    probeSocketExistsMock.mockReturnValue(false)
  })

  afterEach(() => {
    vi.clearAllMocks()
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
    let releaseEnsureRunning: (() => void) | undefined
    const ensureRunningBarrier = new Promise<void>((resolve) => {
      releaseEnsureRunning = resolve
    })
    originalSpawner.ensureRunning.mockImplementationOnce(async () => {
      await ensureRunningBarrier
      return { socketPath: '/fake/socket-2', tokenPath: '/fake/token-2' }
    })

    const call1 = mod.restartDaemon()
    // Yield microtasks so call1 progresses into runRestartDaemon and is
    // definitely blocked on the barrier.
    await Promise.resolve()
    await Promise.resolve()
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
})
