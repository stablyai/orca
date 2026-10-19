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
      hasCachedCredential: vi.fn().mockReturnValue(false),
      getState: vi.fn(),
      disconnectAll: vi.fn(),
      setCallbacks: vi.fn(),
      callbacksRef: { current: null as unknown }
    },
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
    mockPortForwardManager: {
      addForward: vi.fn(),
      updateForward: vi.fn(),
      removeForward: vi.fn(),
      removeForwardAndWait: vi.fn(),
      listForwards: vi.fn().mockReturnValue([]),
      removeAllForwards: vi.fn(),
      closeAll: vi.fn(),
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
    mockMux,
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
    // A managed host by default; the real decision is covered by its own tests.
    hostServerConnect: {
      decideHostServer: vi.fn(async (): Promise<{ route: 'managed'; environmentId: string }> => ({
        route: 'managed',
        environmentId: 'env-test'
      })),
      recheckWhenManagedFenceClears: vi.fn(),
      publishHostServerDecisionFailure: vi.fn(),
      publishManagedServerConnect: vi.fn((targetId: string) => ({
        targetId,
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      })),
      publishUnservedHostServer: vi.fn(() => new Error('This SSH host isn’t supported')),
      publishBridgedUnservedHostServer: vi.fn((target: { id: string }) => ({
        targetId: target.id,
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      }))
    },
    sshConnectionStore: {
      isRuntimeOwnedSshTarget: (target: { owner?: unknown }) => target.owner !== undefined,
      isManagedOrcadSshTarget: (target: { orcadFence?: unknown; orcadProvisioning?: unknown }) =>
        target.orcadFence !== undefined || target.orcadProvisioning !== undefined,
      allowsDirectSshRelay: (target: { orcadFence?: unknown; orcadProvisioning?: unknown }) =>
        target.orcadFence === undefined && target.orcadProvisioning === undefined,
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

    sshChannelMultiplexer: {
      SshChannelMultiplexer: class MockSshChannelMultiplexer {
        constructor() {
          return mockMux
        }
      }
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
