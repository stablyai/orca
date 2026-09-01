import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock, openConsumerSessionMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  openConsumerSessionMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))

vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))

vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: vi.fn().mockResolvedValue(undefined),
  acceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
  allocateSshPtyProviderGeneration: vi.fn(() => 17),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  applySshPtySourceRecoveryCancellationProof: vi.fn(() => true),
  installSshPtySourceAckPublisher: vi.fn(() => () => {}),
  installSshPtySourceCancellationPublisher: vi.fn(() => () => {})
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))

vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))

vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attachForReconnect = vi.fn().mockResolvedValue({})
    dispose = vi.fn()
  }
}))

vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))

vi.mock('../providers/ssh-git-provider', () => ({
  SshGitProvider: class MockSshGitProvider {}
}))

vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn().mockReturnValue({
    attachForReconnect: vi.fn().mockResolvedValue({}),
    dispose: vi.fn()
  }),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true)
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  registerSshFilesystemProvider: vi.fn(),
  unregisterSshFilesystemProvider: vi.fn(),
  getSshFilesystemProvider: vi.fn().mockReturnValue({ dispose: vi.fn() })
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  registerSshGitProvider: vi.fn(),
  unregisterSshGitProvider: vi.fn()
}))

import { SshRelaySession } from './ssh-relay-session'
import { deployAndLaunchRelay } from './ssh-relay-deploy'

describe('SshRelaySession preserved relay build', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockReset().mockResolvedValue([])
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'legacy-fallback',
      clientInstanceId: options.clientInstanceId,
      serverBuildId: 'test-relay-build'
    }))
    mockDeploySuccess()
  })

  it('prefers the persisted build while it still owns a PTY lease', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const targetId = 'target-with-previous-build'
    vi.mocked(mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId,
      clientInstanceId: 'client-1',
      serverBuildId: '0.1.0+111111111111',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'owner-lease'
    })
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      {
        targetId,
        ptyId: 'pty-1',
        state: 'detached',
        createdAt: 1,
        updatedAt: 1
      }
    ])
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(deployAndLaunchRelay).toHaveBeenCalledWith(
      mockConn,
      undefined,
      undefined,
      targetId,
      '0.1.0+111111111111'
    )
  })

  it('uses the current build when no attached or detached lease remains', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const targetId = 'target-with-terminal-leases'
    vi.mocked(mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId,
      clientInstanceId: 'client-2',
      serverBuildId: '0.1.0+111111111111',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'owner-lease'
    })
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      {
        targetId,
        ptyId: 'pty-1',
        state: 'terminated',
        createdAt: 1,
        updatedAt: 1
      },
      {
        targetId,
        ptyId: 'pty-2',
        state: 'expired',
        createdAt: 1,
        updatedAt: 1
      }
    ])
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(deployAndLaunchRelay).toHaveBeenCalledWith(mockConn, undefined, undefined, targetId)
  })
})
