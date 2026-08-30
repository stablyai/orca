import { vi } from 'vitest'
import { PROTOCOL_VERSION } from './types'
import type { Mock } from 'vitest'
import type {
  DaemonInitMockState,
  MockAdapter,
  MockAdapterConstructor,
  MockProbeSocket,
  MockSpawner,
  MockSpawnerConstructor,
  MockSpawnerHandle,
  NetConnectStubs
} from './daemon-init-mock-types'

export type { MockAdapter, MockSpawner } from './daemon-init-mock-types'

/** The module objects each test file's own hoisted `vi.mock` factories return. */
export function createDaemonInitModuleFactories(state: DaemonInitMockState) {
  const {
    forkMock,
    probeSocketExistsMock,
    writeFileSyncMock,
    readFileSyncMock,
    unlinkSyncMock,
    netConnectMock,
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
    unlinkOwnedDaemonPidFileMock,
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
    setLocalPtyProviderMock,
    unbindLocalProviderListenersMock,
    rebindLocalProviderListenersMock,
    trackDaemonReplacedMock,
    trackDaemonRetiredMock
  } = state

  // Why: both fakes are annotated with constructor types so the exported factories widen to
  // MockSpawner/MockAdapter instead of leaking their private fields into declaration emit.
  const MockDaemonSpawner: MockSpawnerConstructor = class MockDaemonSpawner {
    readonly launcher: unknown
    readonly ensureRunning: Mock
    readonly resetHandle: Mock
    readonly resetRespawnWindow: Mock
    readonly shutdown: Mock
    readonly getHandle: Mock
    private socketCounter: number
    private handle: MockSpawnerHandle | null
    constructor(opts: { runtimeDir: string; launcher: unknown }) {
      this.launcher = opts.launcher
      this.socketCounter = 0
      this.handle = null
      // Why: each ensureRunning bumps a counter into socketPath so tests can tell the replacement adapter used the second call, not the first.
      this.ensureRunning = vi.fn(async () => {
        const override = ensureRunningOverrides.shift()
        if (override) {
          const result = await override()
          const releaseAdoptionLease = vi.fn()
          adoptionLeaseReleases.push(releaseAdoptionLease)
          this.handle = {
            releaseAdoptionLease,
            shutdown: vi.fn(async () => {})
          }
          if (result.mode) {
            this.handle.mode = result.mode
          }
          return {
            socketPath: result.socketPath,
            tokenPath: result.tokenPath
          }
        }
        this.socketCounter += 1
        const releaseAdoptionLease = vi.fn()
        adoptionLeaseReleases.push(releaseAdoptionLease)
        this.handle = { releaseAdoptionLease, shutdown: vi.fn(async () => {}) }
        return {
          socketPath: `/fake/socket-${this.socketCounter}`,
          tokenPath: `/fake/token-${this.socketCounter}`
        }
      })
      this.resetHandle = vi.fn()
      this.resetRespawnWindow = vi.fn()
      this.shutdown = vi.fn(async () => {})
      this.getHandle = vi.fn(() => this.handle)
      spawnerInstances.push(this as unknown as MockSpawner)
    }
  }

  const MockDaemonPtyAdapter: MockAdapterConstructor = class MockDaemonPtyAdapter {
    readonly protocolVersion: number
    readonly options: MockAdapter['options']
    readonly getActiveSessionIds: Mock
    readonly fanoutSyntheticExits: Mock
    readonly listProcesses: Mock
    readonly listSessions: Mock
    readonly establishLifecycleLease: Mock
    readonly shutdown: Mock
    readonly dispose: Mock
    readonly disconnectOnly: Mock
    readonly onData: Mock
    readonly onExit: Mock
    readonly callOrder: string[]
    constructor(opts: MockAdapter['options']) {
      this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
      this.options = opts
      this.callOrder = []
      this.getActiveSessionIds = vi.fn(() => [] as string[])
      this.fanoutSyntheticExits = vi.fn(() => {
        this.callOrder.push('fanoutSyntheticExits')
      })
      this.listProcesses = vi.fn(async () =>
        listProcessesControl.current ? listProcessesControl.current() : []
      )
      this.listSessions = vi.fn(async () => [...defaultListSessionsSessions])
      const lifecycleLeaseError = lifecycleLeaseErrors.shift()
      this.establishLifecycleLease = vi.fn(async () => {
        if (lifecycleLeaseError) {
          throw lifecycleLeaseError
        }
      })
      this.shutdown = vi.fn(async () => {})
      this.dispose = vi.fn()
      const disconnectOnlyError = disconnectOnlyErrors.shift()
      this.disconnectOnly = vi.fn(async () => {
        if (disconnectOnlyError) {
          throw disconnectOnlyError
        }
      })
      this.onData = vi.fn(() => {
        if (routerSubscriptionError.current) {
          const error = routerSubscriptionError.current
          routerSubscriptionError.current = null
          throw error
        }
        return () => {}
      })
      this.onExit = vi.fn(() => () => {})
      adapterInstances.push(this as unknown as MockAdapter)
    }
  }

  return {
    fs: () => ({
      mkdirSync: vi.fn<(...args: unknown[]) => void>(),
      existsSync: (p: string) => probeSocketExistsMock(p) || p.includes('.pid'),
      unlinkSync: unlinkSyncMock,
      readFileSync: readFileSyncMock,
      writeFileSync: writeFileSyncMock
    }),
    net: () => ({
      connect: netConnectMock
    }),
    daemonHealth: () => ({
      checkDaemonHealth: checkDaemonHealthMock,
      getMacDaemonSystemResolverHealth: getMacDaemonSystemResolverHealthMock,
      healthCheckDaemon: healthCheckDaemonMock
    }),
    daemonPidIdentity: () => ({
      getDaemonLaunchIdentity: getDaemonLaunchIdentityMock
    }),
    daemonTccAttribution: () => ({
      getMacDaemonTccAttributionHealth: getMacDaemonTccAttributionHealthMock
    }),
    daemonBundleStaleness: () => ({
      isDaemonStaleForCurrentBundle: isDaemonStaleForCurrentBundleMock
    }),
    daemonStaleKill: () => ({
      killStaleDaemon: killStaleDaemonMock
    }),
    daemonProcessStartTime: () => ({
      getProcessStartedAtMs: getProcessStartedAtMsMock
    }),
    daemonPidFileParse: () => ({
      parseDaemonPidFile: parseDaemonPidFileMock
    }),
    client: () => ({
      DaemonClient: daemonClientMock
    }),
    daemonLifecycleEvent: () => ({
      trackDaemonReplaced: trackDaemonReplacedMock,
      trackDaemonRetired: trackDaemonRetiredMock
    }),
    daemonSpawner: () => ({
      DaemonSpawner: MockDaemonSpawner,
      getDaemonSocketPath: (_dir: string, version?: number) =>
        `/fake/daemon/daemon-v${version ?? PROTOCOL_VERSION}.sock`,
      getDaemonTokenPath: (_dir: string, version?: number) =>
        `/fake/daemon/daemon-v${version ?? PROTOCOL_VERSION}.token`,
      getDaemonPidPath: (_dir: string, version?: number) =>
        `/fake/daemon/daemon-v${version ?? PROTOCOL_VERSION}.pid`,
      serializeDaemonPidFile: (obj: unknown) => JSON.stringify(obj),
      replaceDaemonPidFile: replaceDaemonPidFileMock,
      unlinkOwnedDaemonPidFile: unlinkOwnedDaemonPidFileMock
    }),
    daemonPtyAdapter: () => ({
      DaemonPtyAdapter: MockDaemonPtyAdapter
    }),
    ipcPty: () => ({
      getLocalPtyProvider: getLocalPtyProviderMock,
      setLocalPtyProvider: setLocalPtyProviderMock,
      unbindLocalProviderListeners: unbindLocalProviderListenersMock,
      rebindLocalProviderListeners: rebindLocalProviderListenersMock
    }),
    childProcess: (original: Record<string, unknown>) => ({
      ...original,
      fork: forkMock
    })
  }
}

/** net.connect stubs: the default dead-socket probe every suite installs, plus the one-live-socket variant. */
export function createNetConnectStubs(state: DaemonInitMockState): NetConnectStubs {
  const { netConnectMock, probeSocketExistsMock } = state

  function installDefaultNetConnectStub(): void {
    probeSocketExistsMock.mockReturnValue(false)
    netConnectMock.mockReset()
    netConnectMock.mockImplementation((): MockProbeSocket => {
      const handlers: Record<string, (() => void)[]> = {
        connect: [],
        error: []
      }
      return {
        on(event: string, cb: () => void) {
          handlers[event]?.push(cb)
          if (event === 'error') {
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
  }

  function mockOnlyDaemonSocketAlive(socketSuffix: string): void {
    netConnectMock.mockImplementation((options?: { path?: string }): MockProbeSocket => {
      const live = options?.path?.endsWith(socketSuffix) ?? false
      const handlers: Record<string, (() => void)[]> = { connect: [], error: [] }
      return {
        on(event: string, callback: () => void) {
          handlers[event]?.push(callback)
          if ((live && event === 'connect') || (!live && event === 'error')) {
            queueMicrotask(() => callback())
          }
          return this
        },
        removeListener(event: string, callback: () => void) {
          handlers[event] = handlers[event]?.filter((handler) => handler !== callback) ?? []
          return this
        },
        destroy() {}
      }
    })
  }

  return { installDefaultNetConnectStub, mockOnlyDaemonSocketAlive }
}
