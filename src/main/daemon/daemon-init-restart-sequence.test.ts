import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from './types'
import type * as EndpointProbe from './daemon-endpoint-probe'
const { recoverRetired } = vi.hoisted(() => ({ recoverRetired: vi.fn(async () => {}) }))
vi.mock('./macos-retired-daemon-recovery', () => ({ recoverRetiredMacDaemonJobs: recoverRetired }))
const { endpointProbe } = vi.hoisted(() => {
  const state: { outcome: null | 'missing' | 'unknown' } = { outcome: null }
  return { endpointProbe: state }
})
vi.mock('./daemon-endpoint-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof EndpointProbe>()
  return {
    ...actual,
    probeSocketConnect: (socketPath: string) =>
      endpointProbe.outcome
        ? Promise.resolve(endpointProbe.outcome)
        : actual.probeSocketConnect(socketPath)
  }
})

const {
  probeSocketExistsMock,
  netConnectMock,
  killStaleDaemonMock,
  daemonClientMock,
  spawnerInstances,
  isPackagedMock,
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
    recoverRetired.mockReset().mockResolvedValue(undefined)
    endpointProbe.outcome = null
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('fans pty:exit for every active session *before* unbinding listeners, and killedCount is captured pre-fanout', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    // Clear active IDs during fanout so a late killedCount measurement would be wrong.
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

    expect(result.killedCount).toBe(3)
    expect(originalAdapter.fanoutSyntheticExits).toHaveBeenCalledWith(-1, {
      replacedByRestart: true
    })
    expect(order).toEqual(['fanout', 'unbind'])
    expect(recoverRetired).toHaveBeenCalledOnce()
    expect(recoverRetired.mock.invocationCallOrder[0]).toBeLessThan(
      originalAdapter.fanoutSyntheticExits.mock.invocationCallOrder[0]
    )
  })

  it('still restarts the current daemon when retired-daemon recovery cannot prove cleanup', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    recoverRetired.mockRejectedValueOnce(new Error('retired descendants unverifiable'))
    await expect(mod.restartDaemon()).resolves.toBeDefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retired descendants unverifiable'))
    expect(adapterInstances[0].fanoutSyntheticExits).toHaveBeenCalled()
    expect(spawnerInstances[0].resetHandle).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('refuses a targeted restart before ending anything when another daemon owns the endpoint', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const originalAdapter = adapterInstances[0]
    daemonClientMock.mockImplementation(function MockDaemonClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        ensureConnectedWithin: vi.fn(async () => {}),
        getDaemonIdentity: vi.fn(() => ({ pid: 9000, startedAtMs: 1, launchNonce: 'other' })),
        request: vi.fn(async () => ({ sessions: [] })),
        disconnect: vi.fn()
      }
    })

    await expect(mod.restartDaemon({ expectedDaemonPid: 4288 })).rejects.toThrow(
      'owned by a different daemon'
    )

    expect(originalAdapter.fanoutSyntheticExits).not.toHaveBeenCalled()
    expect(unbindLocalProviderListenersMock).not.toHaveBeenCalled()
    expect(recoverRetired).not.toHaveBeenCalled()
  })

  it('replaces a retired daemon that already left its endpoint', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    const originalAdapter = adapterInstances[0]
    endpointProbe.outcome = 'missing'

    await mod.restartDaemon({ expectedDaemonPid: 4288, endpointMayBeGone: true })

    expect(mod.getDaemonProvider()).not.toBe(originalAdapter)
  })

  it.each(['unknown', null] as const)(
    'still refuses when another daemon may own the endpoint (probe %s)',
    async (outcome) => {
      const mod = await importFresh()
      await mod.initDaemonPtyProvider()
      const originalAdapter = adapterInstances[0]
      // An unanswered probe proves nothing, so ownership is still checked.
      endpointProbe.outcome = outcome
      daemonClientMock.mockImplementation(function MockDaemonClient() {
        return {
          ensureConnected: vi.fn(async () => {}),
          ensureConnectedWithin: vi.fn(async () => {}),
          getDaemonIdentity: vi.fn(() => ({ pid: 9000, startedAtMs: 1, launchNonce: 'other' })),
          request: vi.fn(async () => ({ sessions: [] })),
          disconnect: vi.fn()
        }
      })

      await expect(
        mod.restartDaemon({ expectedDaemonPid: 4288, endpointMayBeGone: true })
      ).rejects.toThrow('owned by a different daemon')
      expect(originalAdapter.fanoutSyntheticExits).not.toHaveBeenCalled()
    }
  )

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

    expect(spawnerInstances).toHaveLength(1)
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(originalSpawner.ensureRunning).toHaveBeenCalledTimes(2)
  })

  it('keeps the launch policy stale-daemon recycle across a restart', async () => {
    const mod = await importFresh()
    isPackagedMock.mockReturnValue(true)
    await mod.initDaemonPtyProvider(undefined, { recycleStaleDaemonOnEveryPlatform: true })
    // Exercise Linux: macOS already recycles without the opt-in.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })
    try {
      await mod.restartDaemon()
    } finally {
      if (platform) {
        Object.defineProperty(process, 'platform', platform)
      }
    }

    expect(adapterInstances[1].options.packagedAppVersion).toBe('1.2.3')
  })

  it('builds a fresh adapter whose respawn callback closes over the same spawner', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const originalSpawner = spawnerInstances[0]
    const originalAdapter = adapterInstances[0]

    await mod.restartDaemon()

    expect(adapterInstances).toHaveLength(2)
    const replacementAdapter = adapterInstances[1]
    expect(replacementAdapter).not.toBe(originalAdapter)
    expect(replacementAdapter.options.socketPath).toBe('/fake/socket-2')
    expect(replacementAdapter.options.tokenPath).toBe('/fake/token-2')

    originalSpawner.resetHandle.mockClear()
    originalSpawner.ensureRunning.mockClear()
    await replacementAdapter.options.respawn?.('daemon_died')
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(originalSpawner.ensureRunning).toHaveBeenCalledTimes(1)
    expect(trackDaemonRetiredMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonRetiredMock).toHaveBeenCalledWith('died_respawn')
    trackDaemonRetiredMock.mockClear()
    trackDaemonReplacedMock.mockClear()
    // Attribute resolver recovery at launch so it is emitted once after the outcome is known.
    await replacementAdapter.options.respawn?.('unhealthy_resolver')
    expect(trackDaemonRetiredMock).not.toHaveBeenCalled()
    expect(trackDaemonReplacedMock).not.toHaveBeenCalled()
    expect(spawnerInstances).toHaveLength(1)
  })

  it('swaps the module-level adapter and re-binds listeners after the new provider is installed', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    expect(setLocalPtyProviderMock).toHaveBeenCalledTimes(1)
    const originalProvider = setLocalPtyProviderMock.mock.calls[0][0]
    expect(originalProvider).toBe(adapterInstances[0])
    expect(mod.getDaemonProvider()).toBe(originalProvider)

    await mod.restartDaemon()

    const replacementAdapter = adapterInstances[1]
    expect(setLocalPtyProviderMock).toHaveBeenCalledTimes(2)
    expect(setLocalPtyProviderMock.mock.calls[1][0]).toBe(replacementAdapter)
    expect(mod.getDaemonProvider()).toBe(replacementAdapter)

    const rebindOrder = rebindLocalProviderListenersMock.mock.invocationCallOrder.at(-1) ?? -1
    const swapOrder = setLocalPtyProviderMock.mock.invocationCallOrder.at(-1) ?? -1
    expect(rebindOrder).toBeGreaterThan(swapOrder)
  })

  // Trigger respawn inside ensureRunning to exercise the real in-flight restart guard.
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

    await outgoingRespawn?.('daemon_died')
    expect(trackDaemonRetiredMock).toHaveBeenCalledTimes(1)
    expect(trackDaemonRetiredMock).toHaveBeenCalledWith('died_respawn')

    // Repeat through the replacement adapter: later restarts use its distinct respawn closure.
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

    // Install a router directly so legacy discovery cannot affect the restart test.
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
    // Observe router disposal to detect leaked subscriptions even if the adapters survive.
    const disposeRouterOnlySpy = vi.spyOn(routerWithLegacy, 'disposeRouterOnly')
    const oldRouterDispose = vi.spyOn(routerWithLegacy, 'dispose')
    mod.replaceDaemonProvider(routerWithLegacy)

    await mod.restartDaemon()

    const provider = mod.getDaemonProvider()
    expect(provider).toBeInstanceOf(DaemonPtyRouter)
    const newRouter = provider as InstanceType<typeof DaemonPtyRouter>
    expect(newRouter).not.toBe(routerWithLegacy)

    const legacies = newRouter.getLegacyAdapters()
    expect(legacies).toHaveLength(1)
    expect(legacies[0]).toBe(legacyAdapter)
    expect(legacyAdapter.dispose).not.toHaveBeenCalled()
    expect(legacyAdapter.disconnectOnly).not.toHaveBeenCalled()
    expect(disposeRouterOnlySpy).toHaveBeenCalledTimes(1)
    expect(oldRouterDispose).not.toHaveBeenCalled()

    expect(legacyAdapter.listProcesses).toHaveBeenCalled()
  })

  it('drops a legacy generation that retired for idle instead of routing to its dead endpoint', async () => {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()

    const { DaemonPtyRouter } = await import('./daemon-pty-router')
    const { DaemonPtyAdapter } = await import('./daemon-pty-adapter')
    const legacyAdapter = new DaemonPtyAdapter({
      socketPath: '/fake/legacy.sock',
      tokenPath: '/fake/legacy.token',
      protocolVersion: 3
    })
    vi.mocked(legacyAdapter.hasRetiredForIdle).mockReturnValue(true)
    const current = adapterInstances[0]
    mod.replaceDaemonProvider(
      new DaemonPtyRouter({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mocked module's adapter class built this instance.
        current: current as unknown as InstanceType<typeof DaemonPtyAdapter>,
        legacy: [legacyAdapter]
      })
    )

    await mod.restartDaemon()

    expect(mod.getDaemonProvider()).toBeInstanceOf(DaemonPtyAdapter)
    expect(mod.getDaemonProvider()).not.toBeInstanceOf(DaemonPtyRouter)
    expect(legacyAdapter.listProcesses).not.toHaveBeenCalled()
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

    // The dead-socket cleanup branch has no observable call; trace resetHandle after it.
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
    void originalEnsureRunning

    // The trace covers the observable order; cleanup has no event in this branch.
    expect(trace).toEqual([
      'fanout',
      'unbind',
      'resetHandle',
      'ensureRunning',
      'replaceProvider',
      'rebind'
    ])

    expect(adapterInstances).toHaveLength(2)
    expect(adapterInstances[1].options.socketPath).toBe('/fake/socket-2')
    expect(adapterInstances[1].establishLifecycleLease).toHaveBeenCalledOnce()
    expect(adapterInstances[1].establishLifecycleLease.mock.invocationCallOrder[0]).toBeLessThan(
      setLocalPtyProviderMock.mock.invocationCallOrder.at(-1) as number
    )
  })

  it('exercises the alive-daemon cleanup path: issues shutdown RPC via DaemonClient before spawning a replacement', async () => {
    const requestMock = vi.fn(async (method: string) => {
      if (method === 'listSessions') {
        return { sessions: [{ sessionId: 'live-1', isAlive: true }] }
      }
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

    // Both path existence and a successful connection are needed for the live-socket branch.
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

    expect(ensureConnectedMock).toHaveBeenCalled()
    expect(requestMock).toHaveBeenCalledWith('shutdown', {
      killSessions: true
    })
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

    // Hold ensureRunning open so the second restart is guaranteed to overlap the first.
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

    // Async wrappers return distinct promises; prove coalescing by observing work while the first is blocked.
    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(adapterInstances).toHaveLength(1)

    releaseEnsureRunning?.()
    const [r1, r2] = await Promise.all([call1, call2])
    expect(r1).toEqual(r2)

    expect(originalSpawner.resetHandle).toHaveBeenCalledTimes(1)
    expect(originalSpawner.ensureRunning).toHaveBeenCalledTimes(2)
    expect(adapterInstances).toHaveLength(2)

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
