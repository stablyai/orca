import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as EndpointProbe from '../../../endpoint/publication/daemon-endpoint-probe'
const { recoverRetired } = vi.hoisted(() => ({ recoverRetired: vi.fn(async () => {}) }))
vi.mock('../../../executable-host/macos/macos-retired-daemon-recovery', () => ({
  recoverRetiredMacDaemonJobs: recoverRetired
}))
const { endpointProbe } = vi.hoisted(() => {
  const state: { outcome: null | 'missing' | 'unknown' } = { outcome: null }
  return { endpointProbe: state }
})
vi.mock('../../../endpoint/publication/daemon-endpoint-probe', async (importOriginal) => {
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
  daemonClientMock,
  spawnerInstances,
  ensureRunningOverrides,
  adoptionLeaseReleases,
  lifecycleLeaseErrors,
  adapterInstances,
  unbindLocalProviderListenersMock,
  rebindLocalProviderListenersMock,
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

    const { DegradedDaemonPtyProvider } = await import('../../routing/degraded-daemon-pty-provider')
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

  // Trigger respawn inside ensureRunning to exercise the real in-flight restart guard.

  it('preserves legacy adapter instances by identity, drains outgoing router via disposeRouterOnly, and re-discovers legacy sessions on the new router', async () => {
    const mod = await importFresh()

    // Install a router directly so legacy discovery cannot affect the restart test.
    await mod.initDaemonPtyProvider()

    const { DaemonPtyRouter } = await import('../../routing/daemon-pty-router')
    const { DaemonPtyAdapter } = await import('../../adapter/daemon-pty-adapter')
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
})
