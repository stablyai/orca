import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from './types'

const {
  probeSocketExistsMock,
  netConnectMock,
  killStaleDaemonMock,
  daemonClientMock,
  spawnerInstances,
  ensureRunningOverrides,
  adoptionLeaseReleases,
  lifecycleLeaseErrors,
  adapterInstances,
  setLocalPtyProviderMock,
  unbindLocalProviderListenersMock,
  rebindLocalProviderListenersMock,
  trackDaemonReplacedMock,
  trackDaemonRetiredMock,
  importFresh,
  mockOnlyDaemonSocketAlive,
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
    await replacementAdapter.options.respawn?.('daemon_died')
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(originalSpawner.ensureRunning).toHaveBeenCalledTimes(1)
    // STA-2376: death → respawn retires, exactly once.
    expect(trackDaemonRetiredMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonRetiredMock).toHaveBeenCalledWith('died_respawn')
    trackDaemonRetiredMock.mockClear()
    trackDaemonReplacedMock.mockClear()
    // STA-2376: the resolver respawn attributes rather than emits — the launch it triggers reports it.
    // Emitting here too would double-count, and would fire before the outcome is known.
    await replacementAdapter.options.respawn?.('unhealthy_resolver')
    expect(trackDaemonRetiredMock).not.toHaveBeenCalled()
    expect(trackDaemonReplacedMock).not.toHaveBeenCalled()
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

  // STA-2376: a manual restart kills the daemon while the outgoing adapter is still live, so a pane
  // respawning on its synthetic exit reaches the death path for a user action. That must not land in
  // the crash bucket. Driven from inside the restart's ensureRunning so restartInFlight is genuinely
  // set, rather than asserting the guard against a flag the test poked itself.
  it('does not report a retirement for a death observed during a manual restart', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const outgoingRespawn = adapterInstances[0].options.respawn
    trackDaemonRetiredMock.mockClear()

    let respawnedMidRestart = false
    ensureRunningOverrides.push(async () => {
      await outgoingRespawn?.('daemon_died')
      respawnedMidRestart = true
      return {
        socketPath: '/fake/restarted-socket',
        tokenPath: '/fake/restarted-token'
      }
    })

    await mod.restartDaemon()

    expect(respawnedMidRestart).toBe(true)
    expect(trackDaemonRetiredMock).not.toHaveBeenCalled()

    // The same closure still retires once the restart has settled, so the guard is scoped, not permanent.
    await outgoingRespawn?.('daemon_died')
    expect(trackDaemonRetiredMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonRetiredMock).toHaveBeenCalledWith('died_respawn')

    // The restart installs its own adapter, whose closure is a second copy of the guard — and the one
    // that actually runs in the field from the second restart onward, since the first adapter is gone.
    const restartedRespawn = adapterInstances[1].options.respawn
    trackDaemonRetiredMock.mockClear()
    let respawnedMidSecondRestart = false
    ensureRunningOverrides.push(async () => {
      await restartedRespawn?.('daemon_died')
      respawnedMidSecondRestart = true
      return {
        socketPath: '/fake/restarted-socket-2',
        tokenPath: '/fake/restarted-token-2'
      }
    })

    await mod.restartDaemon()

    expect(respawnedMidSecondRestart).toBe(true)
    expect(trackDaemonRetiredMock).not.toHaveBeenCalled()
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
      const handlers: Record<string, (() => void)[]> = {
        connect: [],
        error: []
      }
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
    expect(requestMock).toHaveBeenCalledWith('shutdown', {
      killSessions: true
    })
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

      await expect(cleanup).resolves.toEqual({
        cleaned: false,
        killedCount: 0
      })
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
})
