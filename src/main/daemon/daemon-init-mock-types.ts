import type { Mock } from 'vitest'

/** Fake DaemonSpawner instance every mocked `new DaemonSpawner()` records. */
export type MockSpawner = {
  ensureRunning: Mock
  resetHandle: Mock
  resetRespawnWindow: Mock
  shutdown: Mock
  getHandle: Mock
  launcher: unknown
}

/** Fake DaemonPtyAdapter instance every mocked `new DaemonPtyAdapter()` records. */
export type MockAdapter = {
  protocolVersion: number
  options: {
    socketPath: string
    tokenPath: string
    historyPath?: string
    packagedAppVersion?: string | null
    respawn?: (
      reason: 'daemon_died' | 'unhealthy_resolver' | 'stale_bundle' | 'severed_tcc_attribution'
    ) => Promise<void>
    protocolVersion?: number
  }
  getActiveSessionIds: Mock
  fanoutSyntheticExits: Mock
  listProcesses: Mock
  listSessions: Mock
  establishLifecycleLease: Mock
  shutdown: Mock
  dispose: Mock
  disconnectOnly: Mock
  onData: Mock
  onExit: Mock
  // Why: the router calls onData/onExit on each adapter; the stub returns a no-op unsubscribe so router subscription doesn't explode.
  callOrder: string[]
}

export type MockSpawnerConstructor = new (opts: {
  runtimeDir: string
  launcher: unknown
}) => MockSpawner

export type MockAdapterConstructor = new (opts: MockAdapter['options']) => MockAdapter

/** Handle the fake spawner hands back from ensureRunning/getHandle. */
export type MockSpawnerHandle = {
  mode?: 'degraded-new-pty-fallback'
  adopted?: true
  releaseAdoptionLease?: () => void
  shutdown: () => Promise<void>
}

/** Slice of net.Socket the daemon socket probe drives. */
export type MockProbeSocket = {
  on: (event: string, callback: () => void) => MockProbeSocket
  removeListener: (event: string, callback: () => void) => MockProbeSocket
  destroy: () => void
}

/** Identity the fake daemon child reports through DaemonClient.getDaemonIdentity. */
export type LaunchedDaemonIdentity = {
  pid: number
  startedAtMs: number
  launchNonce: string
}

/** Local (non-daemon) PTY provider the degraded/fallback paths install. */
export type MockLocalPtyProvider = {
  routesFreshSpawnsToLocalProvider: undefined
  spawn: Mock<(opts: { sessionId?: string }) => Promise<{ id: string }>>
  attach: Mock<() => Promise<void>>
  hasPty: Mock<() => boolean>
  write: Mock<(...args: unknown[]) => void>
  resize: Mock<(...args: unknown[]) => void>
  shutdown: Mock<() => Promise<void>>
  sendSignal: Mock<() => Promise<void>>
  getCwd: Mock<() => Promise<string>>
  getInitialCwd: Mock<() => Promise<string>>
  clearBuffer: Mock<() => Promise<void>>
  acknowledgeDataEvent: Mock<(...args: unknown[]) => void>
  hasChildProcesses: Mock<() => Promise<boolean>>
  getForegroundProcess: Mock<() => Promise<null>>
  serialize: Mock<() => Promise<string>>
  revive: Mock<() => Promise<void>>
  listProcesses: Mock<() => Promise<unknown[]>>
  getDefaultShell: Mock<() => Promise<string>>
  getProfiles: Mock<() => Promise<unknown[]>>
  onData: Mock<() => () => void>
  onReplay: Mock<() => () => void>
  onExit: Mock<() => () => void>
}

export type EnsureRunningOverride = () => Promise<{
  socketPath: string
  tokenPath: string
  mode?: 'degraded-new-pty-fallback'
  adopted?: true
}>

/** Every stub daemon-init's suites share, plus the control knobs they mutate per test. */
export type DaemonInitMockState = {
  getPathMock: Mock<() => string>
  getAppPathMock: Mock<() => string>
  isPackagedMock: Mock<() => boolean>
  probeSocketExistsMock: Mock<(path?: string) => boolean>
  writeFileSyncMock: Mock<(...args: unknown[]) => void>
  readFileSyncMock: Mock<(...args: unknown[]) => string>
  unlinkSyncMock: Mock<(...args: unknown[]) => void>
  netConnectMock: Mock<(options?: { path?: string }) => MockProbeSocket>
  forkMock: Mock<(entryPath: string, args: string[], options?: unknown) => unknown>
  checkDaemonHealthMock: Mock<(socketPath?: string, tokenPath?: string) => Promise<string>>
  healthCheckDaemonMock: Mock<(...args: unknown[]) => Promise<boolean>>
  getMacDaemonSystemResolverHealthMock: Mock<(socketPath?: string, tokenPath?: string) => string>
  getMacDaemonTccAttributionHealthMock: Mock<(...args: unknown[]) => Promise<string>>
  getDaemonLaunchIdentityMock: Mock<(...args: unknown[]) => string>
  isDaemonStaleForCurrentBundleMock: Mock<(...args: unknown[]) => boolean>
  killStaleDaemonMock: Mock<
    (...args: unknown[]) => Promise<{ killed: boolean; liveOwnerSurvived: boolean }>
  >
  getProcessStartedAtMsMock: Mock<(...args: unknown[]) => number | null>
  parseDaemonPidFileMock: Mock<
    (...args: unknown[]) => { pid: number; startedAtMs: number | null } | null
  >
  replaceDaemonPidFileMock: Mock<(...args: unknown[]) => boolean>
  getDaemonCommandLineMock: Mock<(pid: number) => Promise<string | null>>
  unlinkOwnedDaemonPidFileMock: Mock<(...args: unknown[]) => boolean>
  launchedStartedAtMs: { current: number }
  readLaunchedDaemonIdentity: () => LaunchedDaemonIdentity | null
  daemonClientMock: Mock<(...args: unknown[]) => unknown>
  spawnerInstances: MockSpawner[]
  ensureRunningOverrides: EnsureRunningOverride[]
  adoptionLeaseReleases: Mock<(...args: unknown[]) => void>[]
  lifecycleLeaseErrors: Error[]
  disconnectOnlyErrors: Error[]
  routerSubscriptionError: { current: Error | null }
  adapterInstances: MockAdapter[]
  defaultListSessionsSessions: { sessionId: string }[]
  listProcessesControl: { current: null | (() => Promise<{ sessionId: string }[]>) }
  getLocalPtyProviderMock: Mock<() => MockLocalPtyProvider>
  localFallbackProvider: MockLocalPtyProvider
  setLocalPtyProviderMock: Mock<(...args: unknown[]) => void>
  unbindLocalProviderListenersMock: Mock<(...args: unknown[]) => void>
  rebindLocalProviderListenersMock: Mock<(...args: unknown[]) => void>
  trackDaemonReplacedMock: Mock<(...args: unknown[]) => void>
  trackDaemonRetiredMock: Mock<(...args: unknown[]) => void>
  trackDaemonAdoptedMock: Mock<(...args: unknown[]) => void>
}

/** net.connect stubs the suites install in beforeEach. */
export type NetConnectStubs = {
  installDefaultNetConnectStub: () => void
  mockOnlyDaemonSocketAlive: (socketSuffix: string) => void
}
