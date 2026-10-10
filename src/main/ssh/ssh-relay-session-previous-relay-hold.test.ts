// After an app update the new relay answers "not found" for a PTY the previous build's relay still
// runs. While that older relay is live, the session must keep the lease and the pane instead of
// disowning the id, which is what replaced a user's running terminal with an empty shell.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { acceptOutputDataMock, muxRequestMock, openConsumerSessionMock, pauseAdapterMock } =
  vi.hoisted(() => ({
    acceptOutputDataMock: vi.fn().mockResolvedValue(undefined),
    muxRequestMock: vi.fn(),
    openConsumerSessionMock: vi.fn(),
    pauseAdapterMock: vi.fn()
  }))

vi.mock('./ssh-relay-deploy', () => ({
  deployAndLaunchRelay: vi.fn()
}))

vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))

vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: acceptOutputDataMock,
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

vi.mock('./ssh-relay-deploy-helpers', () => ({
  execCommand: vi.fn().mockResolvedValue('')
}))

vi.mock('./ssh-channel-multiplexer', () => {
  return {
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
  }
})

vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('not found'),
  isSshPtyIdentityMismatchError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('identity mismatch'),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    setPtyDeliveryPauseAdapter = pauseAdapterMock
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
    dispose: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
    attachForReconnect: vi.fn().mockResolvedValue({})
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

const { isReattachHeldByPreviousRelay, startPreviousRelayCensus } = vi.hoisted(() => ({
  isReattachHeldByPreviousRelay: vi.fn(),
  startPreviousRelayCensus: vi.fn()
}))
vi.mock('./ssh-previous-relay-terminals', () => ({
  isReattachHeldByPreviousRelay,
  startPreviousRelayCensus
}))

const { attachHeldPtyThroughPreviousRelay } = vi.hoisted(() => ({
  attachHeldPtyThroughPreviousRelay: vi.fn()
}))
vi.mock('../providers/ssh-pty-legacy-relay-delegation', () => ({
  attachHeldPtyThroughPreviousRelay
}))

const {
  getSshPtyProvider,
  getPtyIdsForConnection,
  clearProviderPtyState,
  deletePtyOwnership,
  setPtyOwnership
} = await import('../ipc/pty')

describe('SshRelaySession reattach while a previous relay is live', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'legacy-fallback',
      clientInstanceId: options.clientInstanceId,
      serverBuildId: 'test-relay-build'
    }))
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    attachHeldPtyThroughPreviousRelay.mockResolvedValue(null)
  })

  async function reconnectWithStalePty(holds: boolean) {
    const deps = createMockDeps()
    const session = new SshRelaySession(
      'target-1',
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )
    await session.establish(deps.mockConn)
    vi.clearAllMocks()
    mockDeploySuccess()
    isReattachHeldByPreviousRelay.mockResolvedValue(holds)
    // The reconnect reaches only these two members of the provider.
    vi.mocked(getSshPtyProvider).mockReturnValue(
      Object.assign(Object.create(null), {
        attachForReconnect: vi.fn().mockRejectedValue(new Error('PTY "pty-old" not found')),
        dispose: vi.fn()
      })
    )
    vi.mocked(getPtyIdsForConnection).mockReturnValue(['pty-old'])
    await session.reconnect(deps.mockConn)
    return deps
  }

  it('starts a census of older relays on every deploy', async () => {
    await reconnectWithStalePty(false)
    expect(startPreviousRelayCensus).toHaveBeenCalledWith(
      expect.anything(),
      'target-1',
      expect.objectContaining({ platform: 'linux-x64' })
    )
  })

  it('keeps the lease and the pane when an older relay may run the PTY', async () => {
    const { mockStore, mockWindow } = await reconnectWithStalePty(true)

    expect(isReattachHeldByPreviousRelay).toHaveBeenCalledWith(
      'target-1',
      expect.objectContaining({ message: 'PTY "pty-old" not found' })
    )
    expect(clearProviderPtyState).not.toHaveBeenCalledWith('ssh:target-1@@pty-old')
    expect(deletePtyOwnership).not.toHaveBeenCalledWith('ssh:target-1@@pty-old')
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'target-1',
      'pty-old',
      'expired'
    )
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith(
      'pty:exit',
      expect.objectContaining({ id: 'ssh:target-1@@pty-old' })
    )
  })

  it('disowns the id as before when no older relay may run it', async () => {
    const { mockStore, mockWindow } = await reconnectWithStalePty(false)

    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('target-1', 'pty-old', 'expired')
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
      id: 'ssh:target-1@@pty-old',
      code: -1,
      ptySourceDisowned: true
    })
  })

  it('resumes a held PTY on reconnect through the older relay that serves it', async () => {
    attachHeldPtyThroughPreviousRelay.mockResolvedValue({ replay: 'old screen' })
    const { mockStore, mockWindow } = await reconnectWithStalePty(true)

    expect(attachHeldPtyThroughPreviousRelay).toHaveBeenCalledWith(
      expect.anything(),
      'ssh:target-1@@pty-old',
      undefined
    )
    expect(setPtyOwnership).toHaveBeenCalledWith('ssh:target-1@@pty-old', 'ssh:target-1')
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:replay', {
      id: 'ssh:target-1@@pty-old',
      data: 'old screen'
    })
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'target-1',
      'pty-old',
      'expired'
    )
  })
})
