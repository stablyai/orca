import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { registerSshHandlers, resetSshHandlerStateForTests } from './ssh'
import type {
  SshConnectionManagerMock,
  SshIpcMocks,
  SshPortForwardManagerMock
} from './ssh-ipc-mock-shapes'

/** Lease slice of the app store the SSH handlers write through. */
export type SshLeaseStoreMock = {
  getRepos: () => unknown[]
  getSshRemotePtyLeases: Mock
  markSshRemotePtyLease: Mock
  removeSshRemotePtyLeases: Mock
}

export type MockBrowserWindow = { isDestroyed: () => boolean; webContents: { send: Mock } }

export type SshIpcHarness = {
  handlers: Map<string, (_event: unknown, args: unknown) => unknown>
  mockStore: SshLeaseStoreMock
  mockWindow: MockBrowserWindow
  createMockWindow: () => MockBrowserWindow
  createConnectionManagerMock: () => SshConnectionManagerMock
  /** Replacement forwarders never exercise the await-able removal path. */
  createPortForwardManagerMock: () => Omit<SshPortForwardManagerMock, 'removeForwardAndWait'>
  reset: () => Promise<void>
}

// Shared fixtures + per-test reset for the SSH IPC handler suites. `reset` is the
// suite `beforeEach`: it rewinds every mocked module and re-registers the handlers.
export function createSshIpcHarness(mocks: SshIpcMocks): SshIpcHarness {
  const {
    handleMock,
    powerMonitorOffMock,
    powerMonitorOnMock,
    mockSshStore,
    mockConnectionManager,
    mockMux,
    mockPortForwardManager,
    mockPortScannerCallbacks,
    mockNextConnectionManagers,
    mockNextPortForwardManagers
  } = mocks
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockStore = {
    getRepos: () => [],
    getSshRemotePtyLeases: vi.fn().mockReturnValue([]),
    markSshRemotePtyLease: vi.fn(),
    removeSshRemotePtyLeases: vi.fn()
  }
  const mockWindow = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  }
  const createMockWindow = () => ({
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  })
  const createConnectionManagerMock = () => ({
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
  })
  const createPortForwardManagerMock = () => ({
    addForward: vi.fn(),
    updateForward: vi.fn(),
    removeForward: vi.fn(),
    listForwards: vi.fn().mockReturnValue([]),
    removeAllForwards: vi.fn(),
    closeAll: vi.fn(),
    dispose: vi.fn(),
    setCallbacks: vi.fn(),
    callbacksRef: { current: null as unknown }
  })
  const reset = async (): Promise<void> => {
    await resetSshHandlerStateForTests()
    handlers.clear()
    mockNextConnectionManagers.length = 0
    mockNextPortForwardManagers.length = 0
    mockPortScannerCallbacks.clear()
    handleMock.mockReset()
    handleMock.mockImplementation((channel: string, handler: (...a: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })

    mockSshStore.listTargets.mockReset().mockReturnValue([])
    mockSshStore.getTarget.mockReset()
    mockSshStore.addTarget.mockReset()
    mockSshStore.updateTarget.mockReset()
    mockSshStore.removeTarget.mockReset()
    mockSshStore.importFromSshConfig.mockReset().mockReturnValue([])
    mockSshStore.lastRepoReadoptions = []
    mockWindow.webContents.send.mockReset()
    mockStore.getSshRemotePtyLeases.mockReset().mockReturnValue([])
    mockStore.markSshRemotePtyLease.mockReset()
    mockStore.removeSshRemotePtyLeases.mockReset()

    mockConnectionManager.connect.mockReset()
    mockConnectionManager.disconnect.mockReset()
    mockConnectionManager.disconnectConnection.mockReset().mockResolvedValue(undefined)
    mockConnectionManager.reconnect.mockReset()
    mockConnectionManager.getConnection.mockReset()
    mockConnectionManager.hasCachedCredential.mockReset().mockReturnValue(false)
    mockConnectionManager.getState.mockReset()
    mockConnectionManager.disconnectAll.mockReset()
    mockConnectionManager.setCallbacks.mockReset()
    mockConnectionManager.callbacksRef.current = null

    mockMux.dispose.mockReset()
    mockMux.isDisposed.mockReset().mockReturnValue(false)
    mockMux.onNotification.mockReset()
    mockMux.onNotificationByMethod.mockReset().mockReturnValue(() => {})
    mockMux.onDispose.mockReset().mockReturnValue(() => {})
    mockMux.request.mockReset().mockResolvedValue({})
    mockMux.probeLiveness.mockReset().mockResolvedValue(false)
    mockPortForwardManager.addForward.mockReset()
    mockPortForwardManager.updateForward.mockReset()
    mockPortForwardManager.removeForward.mockReset()
    mockPortForwardManager.removeForwardAndWait.mockReset()
    mockPortForwardManager.listForwards.mockReset().mockReturnValue([])
    mockPortForwardManager.removeAllForwards.mockReset()
    mockPortForwardManager.closeAll.mockReset().mockResolvedValue(undefined)
    mockPortForwardManager.dispose.mockReset()
    mockPortForwardManager.setCallbacks.mockReset()
    mockPortForwardManager.callbacksRef.current = null
    powerMonitorOnMock.mockReset()
    powerMonitorOffMock.mockReset()

    registerSshHandlers(mockStore as never, () => mockWindow as never)
  }

  return {
    handlers,
    mockStore,
    mockWindow,
    createMockWindow,
    createConnectionManagerMock,
    createPortForwardManagerMock,
    reset
  }
}
