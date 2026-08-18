import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  isPackagedMock,
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
  routerSubscriptionError,
  adapterInstances,
  defaultListSessionsSessions,
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
    expect(adapterInstances[0].options.packagedAppVersion).toBeNull()
    expect(adapterInstances[0].establishLifecycleLease.mock.invocationCallOrder[0]).toBeLessThan(
      adoptionLeaseReleases[0].mock.invocationCallOrder[0]
    )
  })

  it('passes the packaged app version to runtime stale-bundle retirement', async () => {
    const mod = await importFresh()
    isPackagedMock.mockReturnValue(true)

    await mod.initDaemonPtyProvider()

    expect(adapterInstances[0].options.packagedAppVersion).toBe(
      process.platform === 'darwin' ? '1.2.3' : null
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
    expect(localFallbackProvider.spawn).toHaveBeenCalledWith({
      cols: 80,
      rows: 24
    })
    expect(adapterInstances[0].listProcesses).toHaveBeenCalled()
  })

  it('rechecks the preserved daemon endpoint before recovering fresh-spawn routing', async () => {
    const mod = await importFresh()
    ensureRunningOverrides.push(async () => ({
      socketPath: '/fake/degraded-socket',
      tokenPath: '/fake/degraded-token',
      mode: 'degraded-new-pty-fallback'
    }))
    await mod.initDaemonPtyProvider()
    checkDaemonHealthMock.mockClear()

    const { DegradedDaemonPtyProvider } = await import('./degraded-daemon-pty-provider')
    const provider = mod.getDaemonProvider()
    expect(provider).toBeInstanceOf(DegradedDaemonPtyProvider)
    const degradedProvider = provider as InstanceType<typeof DegradedDaemonPtyProvider>

    await expect(degradedProvider.recoverFreshSpawnRouting()).resolves.toBe(true)
    expect(checkDaemonHealthMock).toHaveBeenCalledWith(
      '/fake/degraded-socket',
      '/fake/degraded-token'
    )
    expect(degradedProvider.routesFreshSpawnsToLocalProvider).toBeUndefined()
  })

  it('keeps legacy daemon pid/token files when the probe fails but the pid-file process is alive', async () => {
    // Why: deleting a live legacy daemon's token file makes its sessions permanently unadoptable.
    const mod = await importFresh()
    readFileSyncMock.mockReturnValue('{"pid":123}')
    // process.pid is guaranteed alive, so the liveness probe succeeds.
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
})
