import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const { recoverRetired } = vi.hoisted(() => ({ recoverRetired: vi.fn(async () => {}) }))
vi.mock('../../../executable-host/macos/macos-retired-daemon-recovery', () => ({
  recoverRetiredMacDaemonJobs: recoverRetired
}))
const {
  daemonClientMock,
  ensureRunningOverrides,
  adapterInstances,
  unbindLocalProviderListenersMock,
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
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
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
})
