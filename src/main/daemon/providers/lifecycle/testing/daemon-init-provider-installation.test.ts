import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  probeSocketExistsMock,
  readFileSyncMock,
  unlinkSyncMock,
  checkDaemonHealthMock,
  parseDaemonPidFileMock,
  spawnerInstances,
  ensureRunningOverrides,
  adoptionLeaseReleases,
  lifecycleLeaseErrors,
  disconnectOnlyErrors,
  adapterInstances,
  listProcessesControl,
  getLocalPtyProviderMock,
  localFallbackProvider,
  setLocalPtyProviderMock,
  rebindLocalProviderListenersMock,
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
vi.mock('../../../observability/daemon-adoption-telemetry-event', () =>
  moduleFactories.daemonAdoptionTelemetryEvent()
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
    resolveEnsureRunning({
      socketPath: '/fake/socket-late',
      tokenPath: '/fake/token-late'
    })
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

  // Adoption is absent from daemon_lifecycle, so macOS records a separate TCC attribution event.

  it('routes fresh PTYs to the local fallback when a preserved daemon cannot spawn new PTYs', async () => {
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
    expect(getLocalPtyProviderMock).toHaveBeenCalledOnce()
    expect(setLocalPtyProviderMock).toHaveBeenCalledWith(provider)

    const result = await provider!.spawn({ cols: 80, rows: 24 })

    expect(result.id).toBe('local-fallback-pty')
    expect(localFallbackProvider.spawn).toHaveBeenCalledWith({
      cols: 80,
      rows: 24
    })
    expect(adapterInstances[0].listProcesses).toHaveBeenCalled()
  })

  it('recovers fresh spawns through the startup-failure legacy fallback probe', async () => {
    const mod = await importFresh()
    const failure = new Error('protocol-mismatch')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ensureRunningOverrides.push(async () => {
      throw failure
    })
    probeSocketExistsMock.mockImplementation(
      (socketPath?: string) => socketPath?.endsWith('daemon-v49.sock') ?? false
    )
    mockOnlyDaemonSocketAlive('daemon-v49.sock')

    try {
      await mod.initDaemonPtyProvider()
      expect(warn).toHaveBeenCalledWith(
        '[daemon] Current daemon unavailable; adopting legacy daemon sessions with local fresh spawns',
        failure
      )
      const adoptionWarnIndex = warn.mock.calls.findIndex(
        (call) =>
          call[0] ===
          '[daemon] Current daemon unavailable; adopting legacy daemon sessions with local fresh spawns'
      )
      expect(warn.mock.invocationCallOrder[adoptionWarnIndex]).toBeLessThan(
        setLocalPtyProviderMock.mock.invocationCallOrder[0]
      )
    } finally {
      warn.mockRestore()
    }
    checkDaemonHealthMock.mockClear()

    const { DegradedDaemonPtyProvider } = await import('../../routing/degraded-daemon-pty-provider')
    const provider = mod.getDaemonProvider()
    expect(provider).toBeInstanceOf(DegradedDaemonPtyProvider)
    if (!(provider instanceof DegradedDaemonPtyProvider)) {
      throw new Error('expected DegradedDaemonPtyProvider')
    }
    expect(provider.routesFreshSpawnsToLocalProvider).toBe(true)
    expect(adapterInstances[0].listProcesses).not.toHaveBeenCalled()

    await expect(provider.recoverFreshSpawnRouting()).resolves.toBe(true)
    expect(checkDaemonHealthMock).toHaveBeenCalledWith(
      adapterInstances[0].options.socketPath,
      adapterInstances[0].options.tokenPath
    )
    expect(provider.routesFreshSpawnsToLocalProvider).toBeUndefined()
    await provider.listProcesses()
    expect(adapterInstances[0].listProcesses).toHaveBeenCalledOnce()
  })

  it('disconnects legacy adapters when fallback session discovery fails', async () => {
    const mod = await importFresh()
    const failure = new Error('protocol-mismatch')
    const discoveryError = new Error('legacy inventory failed')
    ensureRunningOverrides.push(async () => {
      throw failure
    })
    probeSocketExistsMock.mockImplementation(
      (socketPath?: string) => socketPath?.endsWith('daemon-v49.sock') ?? false
    )
    mockOnlyDaemonSocketAlive('daemon-v49.sock')
    const { DegradedDaemonPtyProvider } = await import('../../routing/degraded-daemon-pty-provider')
    const discover = vi
      .spyOn(DegradedDaemonPtyProvider.prototype, 'discoverDaemonSessions')
      .mockRejectedValueOnce(discoveryError)

    try {
      const error = await mod.initDaemonPtyProvider().catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(AggregateError)
      expect((error as AggregateError).message).toBe('Legacy daemon fallback failed')
      expect((error as AggregateError).errors).toEqual([failure, discoveryError])
      expect(adapterInstances[0].disconnectOnly).toHaveBeenCalledOnce()
      expect(adapterInstances[1].disconnectOnly).toHaveBeenCalledOnce()
      expect(adapterInstances[0].dispose).not.toHaveBeenCalled()
      expect(setLocalPtyProviderMock).not.toHaveBeenCalled()
      expect(mod.getDaemonProvider()).toBeNull()
    } finally {
      discover.mockRestore()
    }
  })

  it('disposes the current adapter when disconnectOnly rejects during legacy fallback', async () => {
    const mod = await importFresh()
    const failure = new Error('protocol-mismatch')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    ensureRunningOverrides.push(async () => {
      throw failure
    })
    disconnectOnlyErrors.push(new Error('disconnect failed'))

    try {
      await expect(mod.initDaemonPtyProvider()).rejects.toBe(failure)
      expect(warn).not.toHaveBeenCalledWith(
        '[daemon] Current daemon unavailable; adopting legacy daemon sessions with local fresh spawns',
        failure
      )
    } finally {
      warn.mockRestore()
    }

    expect(adapterInstances).toHaveLength(1)
    expect(adapterInstances[0].disconnectOnly).toHaveBeenCalledOnce()
    expect(adapterInstances[0].dispose).toHaveBeenCalledOnce()
    expect(setLocalPtyProviderMock).not.toHaveBeenCalled()
  })

  it('keeps legacy daemon pid/token files when the probe fails but the pid-file process is alive', async () => {
    const mod = await importFresh()
    readFileSyncMock.mockReturnValue('{"pid":123}')
    parseDaemonPidFileMock.mockReturnValue({
      pid: process.pid,
      startedAtMs: null
    })

    await mod.initDaemonPtyProvider()

    const legacyUnlinks = unlinkSyncMock.mock.calls.filter(
      ([p]) => typeof p === 'string' && (p.includes('.token') || p.includes('.pid'))
    )
    expect(legacyUnlinks).toEqual([])
  })
})
