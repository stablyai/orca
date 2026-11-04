import type { Mock } from 'vitest'

// Explicit mock shapes prevent declaration emit from naming @vitest/spy internals.

export type MockCallbacksRef = { current: unknown }

export type SshStoreMock = {
  listTargets: Mock
  listSuppressedSshConfigAliases: Mock
  getTarget: Mock
  addTarget: Mock
  updateTarget: Mock
  removeTarget: Mock
  importFromSshConfig: Mock
  currentSshRouteSnapshot: Mock
  refreshSshRouteSnapshot: Mock
  lastRepoReadoptions: { oldTargetId: string; newTargetId: string; repoIds: string[] }[]
}

export type SshConnectionManagerMock = {
  connect: Mock
  disconnect: Mock
  disconnectConnection: Mock
  reconnect: Mock
  getConnection: Mock
  hasCachedCredential: Mock
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

export type SshPortForwardManagerMock = {
  addForward: Mock
  updateForward: Mock
  removeForward: Mock
  removeForwardAndWait: Mock
  listForwards: Mock
  removeAllForwards: Mock
  closeStaleForwards: Mock
  closeAll: Mock
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
  mockMux: SshChannelMultiplexerMock
  mockPortForwardManager: SshPortForwardManagerMock
  mockPortScannerCallbacks: Map<string, unknown>
  mockListConfigHosts: Mock
  mockResolveConfigHost: Mock
  mockNextConnectionManagers: unknown[]
  mockNextPortForwardManagers: unknown[]
}

export type SshIpcMockModule = Record<string, unknown>

export type SshIpcMockModules = {
  sshConfigHostPicker: SshIpcMockModule
  electron: SshIpcMockModule
  hostServerConnect: SshIpcMockModule
  sshConnectionStore: SshIpcMockModule
  sshConnectionManager: SshIpcMockModule
  sshChannelMultiplexer: SshIpcMockModule
  sshPortForward: SshIpcMockModule
  sshPortScanner: SshIpcMockModule
}

export type SshIpcMocks = SshIpcMockState & SshIpcMockModules
