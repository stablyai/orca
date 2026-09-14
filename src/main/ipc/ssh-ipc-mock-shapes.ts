import type { Mock } from 'vitest'
import type { SshPtySourceFrame } from '../providers/ssh-pty-source-frame'

// Declared shapes for the SSH IPC mock registry. The suites assert on recorded calls rather
// than argument types, so every spy stays `Mock` (vi.fn()'s untyped default) — naming the
// shapes here is what keeps declaration emit from reaching into @vitest/spy internals.

export type SshIpcTestSource = SshPtySourceFrame

/** Callbacks production code hands a manager mock at construction / setCallbacks time. */
export type MockCallbacksRef = { current: unknown }

export type SshStoreMock = {
  listTargets: Mock
  listSuppressedSshConfigAliases: Mock
  getTarget: Mock
  addTarget: Mock
  updateTarget: Mock
  removeTarget: Mock
  importFromSshConfig: Mock
  lastRepoReadoptions: { oldTargetId: string; newTargetId: string; repoIds: string[] }[]
}

export type SshConnectionManagerMock = {
  connect: Mock
  disconnect: Mock
  disconnectConnection: Mock
  reconnect: Mock
  getConnection: Mock
  getState: Mock
  disconnectAll: Mock
  setCallbacks: Mock
  callbacksRef: MockCallbacksRef
}

export type SshChannelMultiplexerMock = {
  dispose: Mock
  isDisposed: Mock
  onNotification: Mock
  onNotificationByMethod: Mock
  onRequest: Mock
  onDispose: Mock
  request: Mock
  notify: Mock
  probeLiveness: Mock
}

export type SshPtyProviderMock = {
  onData: Mock
  onExit: Mock
  onReplay: Mock
  attach: Mock
  attachForReconnect: Mock
  shutdown: Mock
  providerGeneration: number
}

export type SshPortForwardManagerMock = {
  addForward: Mock
  updateForward: Mock
  removeForward: Mock
  removeForwardAndWait: Mock
  listForwards: Mock
  removeAllForwards: Mock
  dispose: Mock
  setCallbacks: Mock
  callbacksRef: MockCallbacksRef
}

export type SshIpcMockState = {
  handleMock: Mock
  powerMonitorOffMock: Mock
  powerMonitorOnMock: Mock
  mockSshStore: SshStoreMock
  mockConnectionManager: SshConnectionManagerMock
  mockDeployAndLaunchRelay: Mock
  mockForceStopRelayForTarget: Mock
  mockAcceptSshPtyOutputData: Mock
  mockAcceptSshPtyOutputExit: Mock
  mockMux: SshChannelMultiplexerMock
  mockPtyProvider: SshPtyProviderMock
  mockFsProvider: Record<string, unknown>
  mockGitProvider: Record<string, unknown>
  mockRegisterSshGitProvider: Mock
  mockPortForwardManager: SshPortForwardManagerMock
  mockPortScannerCallbacks: Map<string, unknown>
  mockListConfigHosts: Mock
  mockResolveConfigHost: Mock
  mockNextConnectionManagers: unknown[]
  mockNextPortForwardManagers: unknown[]
}

/** A module namespace object handed straight back from a `vi.mock` factory. */
export type SshIpcMockModule = Record<string, unknown>

export type SshIpcMockModules = {
  sshConfigHostPicker: SshIpcMockModule
  electron: SshIpcMockModule
  sshPtyOutputIntakeRegistry: SshIpcMockModule
  sshConnectionStore: SshIpcMockModule
  sshConnectionManager: SshIpcMockModule
  sshRelayDeploy: SshIpcMockModule
  sshRelayReset: SshIpcMockModule
  sshChannelMultiplexer: SshIpcMockModule
  sshPtyProvider: SshIpcMockModule
  sshFilesystemProvider: SshIpcMockModule
  pty: SshIpcMockModule
  sshFilesystemDispatch: SshIpcMockModule
  sshGitProvider: SshIpcMockModule
  sshGitDispatch: SshIpcMockModule
  sshPortForward: SshIpcMockModule
  sshPortScanner: SshIpcMockModule
}

export type SshIpcMocks = SshIpcMockState & SshIpcMockModules
