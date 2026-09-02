import { expect, vi } from 'vitest'
import type { Mock } from 'vitest'
import { registerSshHandlers, resetSshHandlerStateForTests } from './ssh'
import { PTY_CONSUMER_SESSION_PROTOCOL_VERSION } from '../../shared/pty-consumer-session'
import { DEFAULT_PTY_SOURCE_WINDOW_SU } from '../../shared/pty-source-credit-contract'
import {
  clearProviderPtyState,
  deletePtyOwnership,
  getSshPtyProvider,
  getPtyIdsForConnection
} from './pty'
import type { SshIpcMocks } from './ssh-ipc-module-mocks'
import type {
  SshConnectionManagerMock,
  SshIpcTestSource,
  SshPortForwardManagerMock
} from './ssh-ipc-mock-shapes'

export type RelayDisposeCallback = (reason: 'shutdown' | 'connection_lost') => void

/** Lease + consumer-recovery slice of the app store the SSH handlers write through. */
export type SshLeaseStoreMock = {
  getRepos: () => unknown[]
  getSshPtyConsumerRecovery: Mock
  upsertSshPtyConsumerRecovery: Mock
  removeSshPtyConsumerRecovery: Mock
  getSshRemotePtyLeases: Mock
  markSshRemotePtyLease: Mock
  markSshRemotePtyLeases: Mock
  markSshRemotePtyLeasesAsync: Mock
  markSshRemotePtyLeasesForShutdown: Mock
  markSshRemotePtyLeasesAttachedAsync: Mock
  removeSshRemotePtyLeases: Mock
  getSshRemotePtyKillIntents: Mock
  pruneExpiredSshRemotePtyKillIntents: Mock
  recordSshRemotePtyKillIntent: Mock
  clearSshRemotePtyKillIntent: Mock
  noteSshRemotePtyKillReplayAttempt: Mock
}

export type MockBrowserWindow = { isDestroyed: () => boolean; webContents: { send: Mock } }

export type RelayLaunchResultMock = {
  transport: { write: Mock; onData: Mock; onClose: Mock }
  platform: string
  serverBuildId: string
}

export type SshIpcHarness = {
  relayBuildId: string
  ipcTestSource: SshIpcTestSource
  handlers: Map<string, (_event: unknown, args: unknown) => unknown>
  mockStore: SshLeaseStoreMock
  mockWindow: MockBrowserWindow
  createMockWindow: () => MockBrowserWindow
  createConnectionManagerMock: () => SshConnectionManagerMock
  /** Replacement forwarders never exercise the await-able removal path. */
  createPortForwardManagerMock: () => Omit<SshPortForwardManagerMock, 'removeForwardAndWait'>
  relayReconnectDelaysMs: readonly number[]
  relayLostStabilizedMs: number
  createRelayLaunchResult: () => RelayLaunchResultMock
  getLatestRelayDisposeCallback: () => RelayDisposeCallback
  useSlowRelayLaunchOnce: (delayMs: number) => void
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
    mockDeployAndLaunchRelay,
    mockForceStopRelayForTarget,
    mockAcceptSshPtyOutputData,
    mockAcceptSshPtyOutputExit,
    mockMux,
    mockPtyProvider,
    mockRegisterSshGitProvider,
    mockPortForwardManager,
    mockPortScannerCallbacks,
    mockNextConnectionManagers,
    mockNextPortForwardManagers
  } = mocks
  const relayBuildId = '0.1.0+ipc-test'
  const ipcTestSource = {
    relayPtyId: 'remote-pty',
    spanId: 'ipc-test-delivery:0:5',
    clientGeneration: 1,
    ownerGeneration: 1,
    deliveryToken: 'ipc-test-delivery',
    sourceStartSu: 0,
    sourceEndSu: 5
  } as const
  const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>()
  const mockStore = {
    getRepos: () => [],
    getSshPtyConsumerRecovery: vi.fn().mockReturnValue(null),
    upsertSshPtyConsumerRecovery: vi.fn(),
    removeSshPtyConsumerRecovery: vi.fn(),
    getSshRemotePtyLeases: vi.fn().mockReturnValue([]),
    markSshRemotePtyLease: vi.fn(),
    markSshRemotePtyLeases: vi.fn(),
    markSshRemotePtyLeasesAsync: vi.fn(),
    markSshRemotePtyLeasesForShutdown: vi.fn(),
    markSshRemotePtyLeasesAttachedAsync: vi.fn(),
    removeSshRemotePtyLeases: vi.fn(),
    getSshRemotePtyKillIntents: vi.fn().mockReturnValue([]),
    pruneExpiredSshRemotePtyKillIntents: vi.fn(),
    recordSshRemotePtyKillIntent: vi.fn(),
    clearSshRemotePtyKillIntent: vi.fn(),
    noteSshRemotePtyKillReplayAttempt: vi.fn()
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
    dispose: vi.fn(),
    setCallbacks: vi.fn(),
    callbacksRef: { current: null as unknown }
  })
  const relayReconnectDelaysMs = [500, 1000, 2000, 4000, 8000, 15_000] as const
  const relayLostStabilizedMs = 5_000
  const createRelayLaunchResult = () => ({
    transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
    platform: 'linux-x64',
    serverBuildId: relayBuildId
  })
  const getLatestRelayDisposeCallback = (): RelayDisposeCallback => {
    const calls = mockMux.onDispose.mock.calls
    const callback = calls.at(-1)?.[0] as RelayDisposeCallback | undefined
    expect(callback).toBeDefined()
    return callback!
  }
  const useSlowRelayLaunchOnce = (delayMs: number): void => {
    mockDeployAndLaunchRelay.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(createRelayLaunchResult()), delayMs)
        })
    )
  }

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
    mockStore.markSshRemotePtyLeases.mockReset()
    mockStore.markSshRemotePtyLeasesAsync.mockReset()
    mockStore.markSshRemotePtyLeasesAttachedAsync.mockReset()
    mockStore.removeSshRemotePtyLeases.mockReset()
    mockStore.upsertSshPtyConsumerRecovery.mockReset()

    mockConnectionManager.connect.mockReset()
    mockConnectionManager.disconnect.mockReset()
    mockConnectionManager.disconnectConnection.mockReset().mockResolvedValue(undefined)
    mockConnectionManager.reconnect.mockReset()
    mockConnectionManager.getConnection.mockReset()
    mockConnectionManager.getState.mockReset()
    mockConnectionManager.disconnectAll.mockReset()
    mockConnectionManager.setCallbacks.mockReset()
    mockConnectionManager.callbacksRef.current = null
    mockForceStopRelayForTarget.mockReset().mockResolvedValue(undefined)
    mockAcceptSshPtyOutputData.mockReset().mockResolvedValue({})
    mockAcceptSshPtyOutputExit.mockReset().mockResolvedValue(undefined)

    mockDeployAndLaunchRelay.mockReset().mockResolvedValue({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      platform: 'linux-x64',
      serverBuildId: relayBuildId
    })
    mockMux.dispose.mockReset()
    mockMux.isDisposed.mockReset().mockReturnValue(false)
    mockMux.onNotification.mockReset()
    mockMux.onNotificationByMethod.mockReset().mockReturnValue(() => {})
    mockMux.onDispose.mockReset().mockReturnValue(() => {})
    mockMux.request.mockReset().mockImplementation((method: string) =>
      Promise.resolve(
        method === 'pty.openClient'
          ? {
              protocolVersion: PTY_CONSUMER_SESSION_PROTOCOL_VERSION,
              serverBuildId: relayBuildId,
              clientGeneration: 1,
              role: 'session-owner',
              ownerGeneration: 1,
              ownerLease: 'ipc-test-owner',
              resumed: false,
              capabilities: {
                outputFlowControl: { version: 1, windowSu: DEFAULT_PTY_SOURCE_WINDOW_SU }
              }
            }
          : {}
      )
    )
    mockMux.probeLiveness.mockReset().mockResolvedValue(false)
    mockPtyProvider.onData.mockReset()
    mockPtyProvider.onExit.mockReset()
    mockPtyProvider.onReplay.mockReset()
    mockPtyProvider.attachForReconnect.mockReset().mockResolvedValue({})
    mockPtyProvider.shutdown.mockReset()
    mockPtyProvider.providerGeneration = 0
    mockRegisterSshGitProvider.mockReset()
    mockPortForwardManager.addForward.mockReset()
    mockPortForwardManager.updateForward.mockReset()
    mockPortForwardManager.removeForward.mockReset()
    mockPortForwardManager.removeForwardAndWait.mockReset()
    mockPortForwardManager.listForwards.mockReset().mockReturnValue([])
    mockPortForwardManager.removeAllForwards.mockReset()
    mockPortForwardManager.dispose.mockReset()
    mockPortForwardManager.setCallbacks.mockReset()
    mockPortForwardManager.callbacksRef.current = null
    powerMonitorOnMock.mockReset()
    powerMonitorOffMock.mockReset()
    vi.mocked(getSshPtyProvider).mockReset()
    vi.mocked(getPtyIdsForConnection).mockReset().mockReturnValue([])
    vi.mocked(clearProviderPtyState).mockReset()
    vi.mocked(deletePtyOwnership).mockReset()

    registerSshHandlers(mockStore as never, () => mockWindow as never)
  }

  return {
    relayBuildId,
    ipcTestSource,
    handlers,
    mockStore,
    mockWindow,
    createMockWindow,
    createConnectionManagerMock,
    createPortForwardManagerMock,
    relayReconnectDelaysMs,
    relayLostStabilizedMs,
    createRelayLaunchResult,
    getLatestRelayDisposeCallback,
    useSlowRelayLaunchOnce,
    reset
  }
}
