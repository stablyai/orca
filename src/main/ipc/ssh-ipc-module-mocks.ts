import { vi } from 'vitest'
import type { SshIpcMockModules, SshIpcMockState, SshIpcMocks } from './ssh-ipc-mock-shapes'

export type { SshIpcMocks }

// Mocked module shapes for the SSH IPC handler tests. Built inside `vi.hoisted` so
// each test file's own `vi.mock` factories can hand the objects back verbatim.
export function createSshIpcMocks(): SshIpcMocks {
  const state: SshIpcMockState = {
    handleMock: vi.fn(),
    powerMonitorOffMock: vi.fn(),
    powerMonitorOnMock: vi.fn(),
    mockSshStore: {
      listTargets: vi.fn().mockReturnValue([]),
      listSuppressedSshConfigAliases: vi.fn().mockReturnValue([]),
      getTarget: vi.fn(),
      addTarget: vi.fn(),
      updateTarget: vi.fn(),
      removeTarget: vi.fn(),
      importFromSshConfig: vi.fn().mockReturnValue([]),
      lastRepoReadoptions: [] as {
        oldTargetId: string
        newTargetId: string
        repoIds: string[]
      }[]
    },
    mockConnectionManager: {
      connect: vi.fn(),
      disconnect: vi.fn(),
      disconnectConnection: vi.fn(),
      reconnect: vi.fn(),
      getConnection: vi.fn(),
      getState: vi.fn(),
      disconnectAll: vi.fn(),
      setCallbacks: vi.fn(),
      callbacksRef: { current: null as unknown }
    },
    mockDeployAndLaunchRelay: vi.fn(),
    mockForceStopRelayForTarget: vi.fn(),
    mockAcceptSshPtyOutputData: vi.fn().mockResolvedValue({}),
    mockAcceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
    mockMux: {
      dispose: vi.fn(),
      isDisposed: vi.fn().mockReturnValue(false),
      onNotification: vi.fn(),
      onNotificationByMethod: vi.fn().mockReturnValue(() => {}),
      onRequest: vi.fn().mockReturnValue(() => {}),
      onDispose: vi.fn().mockReturnValue(() => {}),
      request: vi.fn().mockResolvedValue({}),
      notify: vi.fn(),
      probeLiveness: vi.fn().mockResolvedValue(false)
    },
    mockPtyProvider: {
      onData: vi.fn(),
      onExit: vi.fn(),
      onReplay: vi.fn(),
      attach: vi.fn(),
      attachForReconnect: vi.fn().mockResolvedValue({}),
      shutdown: vi.fn(),
      providerGeneration: 0
    },
    mockFsProvider: {},
    mockGitProvider: {},
    mockRegisterSshGitProvider: vi.fn(),
    mockPortForwardManager: {
      addForward: vi.fn(),
      updateForward: vi.fn(),
      removeForward: vi.fn(),
      removeForwardAndWait: vi.fn(),
      listForwards: vi.fn().mockReturnValue([]),
      removeAllForwards: vi.fn(),
      dispose: vi.fn(),
      setCallbacks: vi.fn(),
      callbacksRef: { current: null as unknown }
    },
    mockPortScannerCallbacks: new Map<string, unknown>(),
    mockListConfigHosts: vi.fn().mockReturnValue({
      hosts: [],
      totalHostCount: 0,
      newHostCount: 0,
      matchCount: 0,
      hasMore: false
    }),
    mockResolveConfigHost: vi.fn().mockResolvedValue(null),
    mockNextConnectionManagers: [] as unknown[],
    mockNextPortForwardManagers: [] as unknown[]
  }
  const {
    handleMock,
    powerMonitorOffMock,
    powerMonitorOnMock,
    mockSshStore,
    mockConnectionManager,
    mockDeployAndLaunchRelay,
    mockForceStopRelayForTarget,
    mockAcceptSshPtyOutputData,
    mockAcceptSshPtyOutputExit,
    mockMux,
    mockPtyProvider,
    mockFsProvider,
    mockGitProvider,
    mockRegisterSshGitProvider,
    mockPortForwardManager,
    mockPortScannerCallbacks,
    mockListConfigHosts,
    mockResolveConfigHost,
    mockNextConnectionManagers,
    mockNextPortForwardManagers
  } = state
  const modules: SshIpcMockModules = {
    sshConfigHostPicker: {
      listUserSshConfigHostSummaries: mockListConfigHosts,
      resolveUserSshConfigHost: mockResolveConfigHost
    },
    electron: {
      ipcMain: {
        handle: handleMock,
        on: vi.fn(),
        once: vi.fn(),
        removeHandler: vi.fn(),
        removeAllListeners: vi.fn()
      },
      powerMonitor: {
        on: powerMonitorOnMock,
        off: powerMonitorOffMock
      }
    },
    sshPtyOutputIntakeRegistry: {
      acceptSshPtyOutputData: mockAcceptSshPtyOutputData,
      acceptSshPtyOutputExit: mockAcceptSshPtyOutputExit,
      allocateSshPtyProviderGeneration: (() => {
        let generation = 0
        return () => ++generation
      })(),
      beginSshPtyOutputGenerationMigration: vi.fn(() => ({
        byPty: new Map(),
        completion: Promise.resolve()
      })),
      applySshPtySourceCancellationProof: vi.fn().mockReturnValue(false),
      applySshPtySourceRecoveryCancellationProof: vi.fn().mockReturnValue(false),
      closeSshPtyOutputGeneration: vi.fn(),
      getSshPtyAcceptedSourceCheckpoints: vi.fn().mockReturnValue([]),
      installSshPtySourceAckPublisher: vi.fn().mockReturnValue(() => {}),
      installSshPtySourceCancellationPublisher: vi.fn().mockReturnValue(() => {})
    },
    sshConnectionStore: {
      SshConnectionStore: class MockSshConnectionStore {
        constructor() {
          return mockSshStore
        }
      }
    },
    sshConnectionManager: {
      SshConnectionManager: class MockSshConnectionManager {
        constructor(callbacks: unknown) {
          const manager = (mockNextConnectionManagers.shift() ??
            mockConnectionManager) as typeof mockConnectionManager
          manager.callbacksRef.current = callbacks
          manager.setCallbacks.mockImplementation((nextCallbacks: unknown) => {
            manager.callbacksRef.current = nextCallbacks
          })
          return manager
        }
      }
    },
    sshRelayDeploy: {
      deployAndLaunchRelay: mockDeployAndLaunchRelay
    },
    sshRelayReset: {
      forceStopRelayForTarget: mockForceStopRelayForTarget
    },
    sshChannelMultiplexer: {
      SshChannelMultiplexer: class MockSshChannelMultiplexer {
        constructor() {
          return mockMux
        }
      }
    },
    sshPtyProvider: {
      SshPtyProvider: class MockSshPtyProvider {
        constructor(_targetId: unknown, _mux: unknown, _env: unknown, providerGeneration: number) {
          mockPtyProvider.providerGeneration = providerGeneration
          return mockPtyProvider
        }
      }
    },
    sshFilesystemProvider: {
      SshFilesystemProvider: class MockSshFilesystemProvider {
        constructor() {
          return mockFsProvider
        }
      }
    },
    pty: {
      registerSshPtyProvider: vi.fn(),
      unregisterSshPtyProvider: vi.fn(),
      clearPtyOwnershipForConnection: vi.fn(),
      clearProviderPtyState: vi.fn(),
      deletePtyOwnership: vi.fn(),
      setPtyOwnership: vi.fn(),
      getSshPtyProvider: vi.fn(),
      getPtyIdsForConnection: vi.fn().mockReturnValue([]),
      isCurrentPtyExit: vi.fn().mockReturnValue(true)
    },
    sshFilesystemDispatch: {
      registerSshFilesystemProvider: vi.fn(),
      unregisterSshFilesystemProvider: vi.fn(),
      getSshFilesystemProvider: vi.fn()
    },
    sshGitProvider: {
      SshGitProvider: class MockSshGitProvider {
        constructor() {
          return mockGitProvider
        }
      }
    },
    sshGitDispatch: {
      registerSshGitProvider: mockRegisterSshGitProvider,
      unregisterSshGitProvider: vi.fn()
    },
    sshPortForward: {
      SshPortForwardManager: class MockPortForwardManager {
        constructor() {
          const manager = (mockNextPortForwardManagers.shift() ??
            mockPortForwardManager) as typeof mockPortForwardManager
          manager.setCallbacks.mockImplementation((callbacks: unknown) => {
            manager.callbacksRef.current = callbacks
          })
          return manager
        }
      }
    },
    sshPortScanner: {
      PortScanner: class MockPortScanner {
        startScanning(targetId: string, _mux: unknown, onChanged: unknown) {
          mockPortScannerCallbacks.set(targetId, onChanged)
        }
        getDetectedPorts() {
          return []
        }
        stopScanning(targetId: string) {
          mockPortScannerCallbacks.delete(targetId)
        }
      }
    }
  }
  return { ...state, ...modules }
}
