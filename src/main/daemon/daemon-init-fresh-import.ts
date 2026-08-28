import { vi } from 'vitest'
import { setAppEnvironment, type AppEnvironment } from '../../shared/app-environment'
import type { DaemonInitMockState } from './daemon-init-test-harness'

/** Resets every mock plus the module registry, then re-imports daemon-init so its module-level spawner/adapter/restartInFlight start fresh. */
export async function importFreshDaemonInit(state: DaemonInitMockState) {
  const {
    getPathMock,
    getAppPathMock,
    isPackagedMock,
    probeSocketExistsMock,
    writeFileSyncMock,
    readFileSyncMock,
    unlinkSyncMock,
    forkMock,
    checkDaemonHealthMock,
    healthCheckDaemonMock,
    getMacDaemonSystemResolverHealthMock,
    getMacDaemonTccAttributionHealthMock,
    getDaemonLaunchIdentityMock,
    isDaemonStaleForCurrentBundleMock,
    killStaleDaemonMock,
    getProcessStartedAtMsMock,
    parseDaemonPidFileMock,
    unlinkOwnedDaemonPidFileMock,
    launchedStartedAtMs,
    readLaunchedDaemonIdentity,
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
    rebindLocalProviderListenersMock,
    trackDaemonReplacedMock,
    trackDaemonRetiredMock
  } = state

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
  trackDaemonReplacedMock.mockClear()
  trackDaemonRetiredMock.mockClear()
  checkDaemonHealthMock.mockClear()
  checkDaemonHealthMock.mockResolvedValue('healthy')
  healthCheckDaemonMock.mockClear()
  healthCheckDaemonMock.mockResolvedValue(true)
  getMacDaemonSystemResolverHealthMock.mockReset()
  getMacDaemonSystemResolverHealthMock.mockReturnValue('healthy')
  getMacDaemonTccAttributionHealthMock.mockReset()
  getMacDaemonTccAttributionHealthMock.mockResolvedValue('unknown')
  getDaemonLaunchIdentityMock.mockClear()
  isDaemonStaleForCurrentBundleMock.mockReset()
  isDaemonStaleForCurrentBundleMock.mockReturnValue(false)
  // mockReset (not mockClear) also drops an unconsumed *Once queue, so a test that bails early
  // can't leak a queued false into the next test's confirmedReplacement gate.
  killStaleDaemonMock.mockReset()
  killStaleDaemonMock.mockResolvedValue({
    killed: true,
    liveOwnerSurvived: false
  })
  getAppPathMock.mockReset()
  getAppPathMock.mockReturnValue('/fake/app')
  forkMock.mockReset()
  isPackagedMock.mockReset()
  isPackagedMock.mockReturnValue(false)
  daemonClientMock.mockReset()
  daemonClientMock.mockImplementation(function MockDaemonClient() {
    return {
      ensureConnected: vi.fn(async () => {}),
      getDaemonIdentity: vi.fn(readLaunchedDaemonIdentity),
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
  launchedStartedAtMs.current = 1_000_000
  getProcessStartedAtMsMock.mockReset()
  getProcessStartedAtMsMock.mockReturnValue(1_000_000)
  // Why the real port rather than a module mock: daemon-init reads AppEnvironment, whose
  // installed instance is anchored to a realm symbol precisely so it survives resetModules.
  setAppEnvironment({
    getPath: getPathMock,
    getAppPath: getAppPathMock,
    getVersion: () => '1.2.3',
    isPackaged: isPackagedMock,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  } as unknown as AppEnvironment)
  // Why: import after resetModules so module-level spawner/adapter/restartInFlight start fresh — needed to test first-init and the coalescer.
  return import('./daemon-init')
}
