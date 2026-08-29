import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock, openConsumerSessionMock, listProcessesMock, shutdownMock } = vi.hoisted(
  () => ({
    muxRequestMock: vi.fn(),
    openConsumerSessionMock: vi.fn(),
    listProcessesMock: vi.fn(),
    shutdownMock: vi.fn()
  })
)

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: vi.fn().mockResolvedValue(undefined),
  acceptSshPtyOutputExit: vi.fn().mockResolvedValue(undefined),
  allocateSshPtyProviderGeneration: vi.fn(() => 41),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  applySshPtySourceCancellationProof: vi.fn(() => true),
  applySshPtySourceRecoveryCancellationProof: vi.fn(() => true),
  installSshPtySourceAckPublisher: vi.fn(() => () => {}),
  installSshPtySourceCancellationPublisher: vi.fn(() => () => {})
}))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
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
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    setPtyDeliveryPauseAdapter = vi.fn()
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-filesystem-provider', () => ({
  SshFilesystemProvider: class MockSshFilesystemProvider {
    dispose = vi.fn()
  }
}))
vi.mock('../providers/ssh-git-provider', () => ({ SshGitProvider: class MockSshGitProvider {} }))
vi.mock('../ipc/pty', () => ({
  registerSshPtyProvider: vi.fn(),
  unregisterSshPtyProvider: vi.fn(),
  getSshPtyProvider: vi.fn().mockReturnValue({
    dispose: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
    attachForReconnect: vi.fn().mockResolvedValue({}),
    listProcesses: listProcessesMock,
    shutdown: shutdownMock
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

const NOW = 1_800_000_000_000

describe('SshRelaySession pending PTY kill replay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'legacy-fallback',
      clientInstanceId: options.clientInstanceId,
      serverBuildId: 'test-relay-build'
    }))
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
  })

  it('replays a stop the client could not deliver, before reattach reads the leases', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const order: string[] = []
    vi.mocked(mockStore.getSshRemotePtyKillIntents).mockReturnValue([
      { ptyId: 'pty-3', intent: { requestedAt: NOW, incarnationId: 'inc-a', attempts: 0 } }
    ])
    vi.mocked(mockStore.getSshRemotePtyLeases).mockImplementation(() => {
      order.push('read-leases')
      return []
    })
    let live = true
    listProcessesMock.mockImplementation(async () =>
      live ? [{ id: 'ssh:target-1@@pty-3', incarnationId: 'inc-a' }] : []
    )
    shutdownMock.mockImplementation(async (id: string) => {
      order.push(`shutdown:${id}`)
      live = false
    })

    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(shutdownMock).toHaveBeenCalledWith('ssh:target-1@@pty-3', { immediate: true })
    expect(order).toEqual(['shutdown:ssh:target-1@@pty-3', 'read-leases'])
    expect(mockStore.clearSshRemotePtyKillIntent).toHaveBeenCalledWith('target-1', 'pty-3')
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('target-1', 'pty-3', 'terminated')
  })

  it('costs no host round trip when nothing is pending', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    expect(listProcessesMock).not.toHaveBeenCalled()
    expect(shutdownMock).not.toHaveBeenCalled()
  })
})
