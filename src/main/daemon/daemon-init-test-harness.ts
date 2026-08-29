import { vi } from 'vitest'
import { join } from 'node:path'
import {
  createDaemonInitModuleFactories,
  createNetConnectStubs
} from './daemon-init-dependency-mocks'
import { importFreshDaemonInit } from './daemon-init-fresh-import'
import type {
  DaemonInitMockState,
  EnsureRunningOverride,
  LaunchedDaemonIdentity,
  MockAdapter,
  MockLocalPtyProvider,
  MockProbeSocket,
  MockSpawner,
  NetConnectStubs
} from './daemon-init-mock-types'

export type { DaemonInitMockState } from './daemon-init-mock-types'

/** Everything a daemon-init suite destructures out of its hoisted mock graph. */
export type DaemonInitMocks = DaemonInitMockState &
  NetConnectStubs & {
    mockConnectedAdoptionClientOnce: () => void
    importFresh: () => ReturnType<typeof importFreshDaemonInit>
    moduleFactories: ReturnType<typeof createDaemonInitModuleFactories>
  }

export const FAKE_USER_DATA_PATH = '/fake/userData'
export const FAKE_RUNTIME_DIR = join(FAKE_USER_DATA_PATH, 'daemon')
export const FAKE_APP_PATH = '/fake/app'
export const FAKE_APP_OUT_MAIN_PATH = join(FAKE_APP_PATH, 'out', 'main')
export const FAKE_DAEMON_ENTRY_PATH = join(FAKE_APP_OUT_MAIN_PATH, 'daemon-entry.js')

// Why: we only care about runRestartDaemon's observable sequencing/identity invariants, so every non-daemon-init dependency is a minimal stub.
function createDaemonInitMockState(): DaemonInitMockState {
  const getPathMock = vi.fn(() => '/fake/userData')
  const getAppPathMock = vi.fn(() => '/fake/app')
  const isPackagedMock = vi.fn(() => false)

  const probeSocketExistsMock = vi.fn((_path?: string) => false)
  const writeFileSyncMock = vi.fn()
  // Why: readFileSync throws by default so legacyDaemonProcessMayBeAlive treats every legacy pid file as unreadable (pre-fix cleanup behavior).
  const readFileSyncMock = vi.fn((): string => {
    throw new Error('ENOENT')
  })
  const unlinkSyncMock = vi.fn()
  const forkMock = vi.fn()
  const netConnectMock = vi.fn((): MockProbeSocket => {
    // Why: stub the socket so probeSocket's 'error' path fires and cleanupDaemonForProtocol's alive=false branch runs without side effects.
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
  const getMacDaemonTccAttributionHealthMock = vi.fn(async () => 'unknown')
  const getDaemonLaunchIdentityMock = vi.fn(() => 'match')
  const isDaemonStaleForCurrentBundleMock = vi.fn(() => false)
  const killStaleDaemonMock = vi.fn(async () => ({
    killed: true,
    liveOwnerSurvived: false
  }))
  const getProcessStartedAtMsMock = vi.fn((): number | null => 1_000_000)
  const parseDaemonPidFileMock = vi.fn(
    (): { pid: number; startedAtMs: number | null } | null => null
  )
  const replaceDaemonPidFileMock = vi.fn(() => true)
  const getDaemonCommandLineMock = vi.fn(async (_pid: number): Promise<string | null> => null)
  const unlinkOwnedDaemonPidFileMock = vi.fn(() => true)
  const launchedStartedAtMs = { current: 1_000_000 }

  const readLaunchedDaemonIdentity = (): LaunchedDaemonIdentity | null => {
    const args = forkMock.mock.calls.at(-1)?.[1]
    const child = forkMock.mock.results.at(-1)?.value as { pid?: unknown } | undefined
    const launchNonceIndex = Array.isArray(args) ? args.indexOf('--launch-nonce') : -1
    const launchNonce = launchNonceIndex >= 0 ? args[launchNonceIndex + 1] : undefined
    return typeof child?.pid === 'number' && typeof launchNonce === 'string'
      ? {
          pid: child.pid,
          startedAtMs: launchedStartedAtMs.current,
          launchNonce
        }
      : null
  }

  const daemonClientMock = vi.fn().mockImplementation(function MockDaemonClient() {
    return {
      ensureConnected: vi.fn(async () => {}),
      getDaemonIdentity: vi.fn(readLaunchedDaemonIdentity),
      request: vi.fn(async () => ({ sessions: [] })),
      disconnect: vi.fn()
    }
  })

  // Why: every DaemonSpawner pushes here so assertions can check the *same* spawner was reused across restart.
  const spawnerInstances: MockSpawner[] = []
  const ensureRunningOverrides: EnsureRunningOverride[] = []
  const adoptionLeaseReleases: DaemonInitMockState['adoptionLeaseReleases'] = []
  const lifecycleLeaseErrors: Error[] = []
  const disconnectOnlyErrors: Error[] = []
  const routerSubscriptionError: { current: Error | null } = { current: null }
  // Same for DaemonPtyAdapter — tests assert the replacement adapter is fresh but its respawn closure targets the *original* spawner.
  const adapterInstances: MockAdapter[] = []
  // Why: adapters are built inside initDaemonPtyProvider, so tests set this before init to make listSessions report live sessions.
  const defaultListSessionsSessions: { sessionId: string }[] = []
  const listProcessesControl: {
    current: null | (() => Promise<{ sessionId: string }[]>)
  } = { current: null }

  const localFallbackProvider: MockLocalPtyProvider = {
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
  const trackDaemonReplacedMock = vi.fn()
  const trackDaemonRetiredMock = vi.fn()

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
    getMacDaemonTccAttributionHealthMock,
    getDaemonLaunchIdentityMock,
    isDaemonStaleForCurrentBundleMock,
    killStaleDaemonMock,
    getProcessStartedAtMsMock,
    parseDaemonPidFileMock,
    replaceDaemonPidFileMock,
    getDaemonCommandLineMock,
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
  }
}

/**
 * Builds the daemon-init mock graph, the per-module factories each test file feeds to its own
 * hoisted `vi.mock` calls, and the fresh-import helper. Call it from an awaited `vi.hoisted`
 * block so the mocks exist before those factories run.
 */
export function createDaemonInitMocks(): DaemonInitMocks {
  const state = createDaemonInitMockState()

  function mockConnectedAdoptionClientOnce(): void {
    state.daemonClientMock.mockImplementationOnce(function MockAdoptionClient() {
      return {
        ensureConnected: vi.fn(async () => {}),
        request: vi.fn(),
        disconnect: vi.fn()
      }
    })
  }

  return {
    ...state,
    ...createNetConnectStubs(state),
    mockConnectedAdoptionClientOnce,
    importFresh: () => importFreshDaemonInit(state),
    moduleFactories: createDaemonInitModuleFactories(state)
  }
}
