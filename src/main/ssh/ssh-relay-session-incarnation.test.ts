import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { acceptOutputDataMock, acceptOutputExitMock, muxRequestMock } = vi.hoisted(() => ({
  acceptOutputDataMock: vi.fn().mockResolvedValue(undefined),
  acceptOutputExitMock: vi.fn().mockResolvedValue(undefined),
  muxRequestMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: vi.fn(async (_mux, options) => ({
    clientInstanceId: options.clientInstanceId,
    clientGeneration: 1,
    ownerGeneration: 1,
    ownerLease: 'test-owner-lease'
  }))
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: acceptOutputDataMock,
  acceptSshPtyOutputExit: acceptOutputExitMock,
  allocateSshPtyProviderGeneration: vi.fn(() => 31),
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
vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: vi.fn().mockResolvedValue([])
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class MockSshPtyProvider {
    private readonly pendingLiveEvidence = new Map<string, Set<{ valid: boolean }>>()
    readonly providerGeneration: number
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = vi.fn().mockResolvedValue({})
    acceptLivePty = vi.fn()
    beginLivePtyEvidence = vi.fn((id: string) => {
      const evidence = { valid: true }
      const pending = this.pendingLiveEvidence.get(id) ?? new Set<{ valid: boolean }>()
      pending.add(evidence)
      this.pendingLiveEvidence.set(id, pending)
      return evidence
    })
    settleLivePtyEvidence = vi.fn(
      (id: string, evidence: { valid: boolean }, acceptLive: boolean) => {
        this.pendingLiveEvidence.get(id)?.delete(evidence)
        if (evidence.valid && acceptLive) {
          this.acceptLivePty(id)
        }
      }
    )
    // Mirrors SshPtyLivenessState: only the named PTY's pending live evidence is invalidated.
    acceptUnverifiablePty = vi.fn((id: string) => {
      for (const evidence of this.pendingLiveEvidence.get(id) ?? []) {
        evidence.valid = false
      }
      this.pendingLiveEvidence.delete(id)
    })
    acceptAmbiguousExitPty = vi.fn((id: string) => this.acceptUnverifiablePty(id))
    acceptExitedPtyLiveness = vi.fn((id: string) => {
      for (const evidence of this.pendingLiveEvidence.get(id) ?? []) {
        evidence.valid = false
      }
      this.pendingLiveEvidence.delete(id)
    })
    acceptExitedPty = vi.fn()
    dispose = vi.fn()

    constructor(_connectionId: string, _mux: unknown, _env: unknown, providerGeneration: number) {
      this.providerGeneration = providerGeneration
    }
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
  getSshPtyProvider: vi.fn().mockReturnValue({ dispose: vi.fn() }),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true),
  answerStartupTerminalColorQueriesForPty: vi.fn((_id: string, data: string) => data)
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

const {
  registerSshPtyProvider,
  getSshPtyProvider,
  clearProviderPtyState,
  deletePtyOwnership,
  isCurrentPtyExit
} = await import('../ipc/pty')

describe('SSH relay PTY incarnation exits', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockResolvedValue([])
    acceptOutputDataMock.mockResolvedValue(undefined)
    mockDeploySuccess()
    vi.mocked(isCurrentPtyExit).mockReturnValue(true)
  })

  it('drops a stale exit before ownership cleanup and propagates a current incarnation', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const runtime = { onPtyData: vi.fn(), onPtyExit: vi.fn() }
    const session = new SshRelaySession(
      'target-1',
      getMainWindow,
      mockStore,
      mockPortForward,
      runtime as never
    )
    await session.establish(mockConn)
    const provider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      onExit: ReturnType<typeof vi.fn>
      acceptUnverifiablePty: ReturnType<typeof vi.fn>
    }
    const onExit = provider.onExit.mock.calls[0]?.[0] as (payload: {
      id: string
      code: number
      incarnationId: string
      providerGeneration: number
      ptyIncarnation: string
    }) => void
    const acceptExitedPty = vi.fn()
    const acceptExitedPtyLiveness = vi.fn()
    vi.mocked(getSshPtyProvider).mockReturnValue({
      providerGeneration: 31,
      acceptExitedPtyLiveness,
      acceptExitedPty
    } as never)
    vi.mocked(isCurrentPtyExit).mockReturnValueOnce(true).mockReturnValueOnce(false)

    onExit({
      id: 'ssh:target-1@@pty-reused',
      code: 0,
      incarnationId: 'old-incarnation',
      providerGeneration: 31,
      ptyIncarnation: 'old-incarnation'
    })

    expect(clearProviderPtyState).not.toHaveBeenCalled()
    expect(deletePtyOwnership).not.toHaveBeenCalled()
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalled()
    expect(acceptOutputExitMock).not.toHaveBeenCalled()
    expect(acceptExitedPty).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())

    onExit({
      id: 'ssh:target-1@@pty-reused',
      code: 7,
      incarnationId: 'current-incarnation',
      providerGeneration: 31,
      ptyIncarnation: 'current-incarnation'
    })
    await vi.waitFor(() =>
      expect(acceptOutputExitMock).toHaveBeenCalledWith({
        id: 'ssh:target-1@@pty-reused',
        code: 7,
        providerGeneration: 31,
        ptyIncarnation: 'current-incarnation'
      })
    )
    expect(acceptExitedPty).toHaveBeenCalledExactlyOnceWith('ssh:target-1@@pty-reused')
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
  })

  it('records exact exited liveness before output-exit settlement', async () => {
    let settleExit!: () => void
    acceptOutputExitMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settleExit = resolve
      })
    )
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    const provider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      providerGeneration: number
      onExit: ReturnType<typeof vi.fn>
      acceptExitedPtyLiveness: ReturnType<typeof vi.fn>
      acceptExitedPty: ReturnType<typeof vi.fn>
    }
    vi.mocked(getSshPtyProvider).mockReturnValue(provider as never)
    const onExit = provider.onExit.mock.calls[0]?.[0] as (payload: {
      id: string
      code: number
      incarnationId: string
      providerGeneration: number
      ptyIncarnation: string
    }) => void
    const id = 'ssh:target-1@@pty-current'

    onExit({
      id,
      code: 0,
      incarnationId: 'incarnation-current',
      providerGeneration: provider.providerGeneration,
      ptyIncarnation: 'incarnation-current'
    })

    expect(provider.acceptExitedPtyLiveness).toHaveBeenCalledExactlyOnceWith(id)
    expect(provider.acceptExitedPty).not.toHaveBeenCalled()
    settleExit()
    await vi.waitFor(() => expect(provider.acceptExitedPty).toHaveBeenCalledExactlyOnceWith(id))
  })

  it('promotes liveness only after current output passes intake fencing', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    const provider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      onData: ReturnType<typeof vi.fn>
    }
    const onData = provider.onData.mock.calls[0]?.[0] as (payload: {
      id: string
      data: string
      providerGeneration: number
      ptyIncarnation: string
    }) => void
    const acceptLivePty = vi.fn()
    const beginLivePtyEvidence = vi.fn(() => ({ valid: true }))
    const settleLivePtyEvidence = vi.fn(
      (id: string, evidence: { valid: boolean }, acceptLive: boolean) => {
        if (evidence.valid && acceptLive) {
          acceptLivePty(id)
        }
      }
    )
    vi.mocked(getSshPtyProvider).mockReturnValue({
      providerGeneration: 31,
      acceptLivePty,
      beginLivePtyEvidence,
      settleLivePtyEvidence
    } as never)
    acceptOutputDataMock.mockRejectedValueOnce(new Error('stale incarnation'))

    onData({
      id: 'ssh:target-1@@pty-reused',
      data: 'stale',
      providerGeneration: 31,
      ptyIncarnation: 'old-incarnation'
    })
    await vi.waitFor(() => expect(acceptOutputDataMock).toHaveBeenCalledTimes(1))
    expect(acceptLivePty).not.toHaveBeenCalled()

    onData({
      id: 'ssh:target-1@@pty-reused',
      data: 'current',
      providerGeneration: 31,
      ptyIncarnation: 'current-incarnation'
    })
    await vi.waitFor(() =>
      expect(acceptLivePty).toHaveBeenCalledExactlyOnceWith('ssh:target-1@@pty-reused')
    )
  })

  it('does not promote delayed output after a newer legacy exit', async () => {
    let settleOutput!: () => void
    acceptOutputDataMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        settleOutput = resolve
      })
    )
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    const provider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      providerGeneration: number
      onData: ReturnType<typeof vi.fn>
      onExit: ReturnType<typeof vi.fn>
      acceptLivePty: ReturnType<typeof vi.fn>
      acceptExitedPtyLiveness: ReturnType<typeof vi.fn>
      settleLivePtyEvidence: ReturnType<typeof vi.fn>
    }
    vi.mocked(getSshPtyProvider).mockReturnValue(provider as never)
    const onData = provider.onData.mock.calls[0]?.[0] as (payload: {
      id: string
      data: string
      providerGeneration: number
      ptyIncarnation: string
    }) => void
    const onExit = provider.onExit.mock.calls[0]?.[0] as (payload: {
      id: string
      code: number
      providerGeneration: number
      ptyIncarnation: string
    }) => void
    const id = 'ssh:target-1@@pty-current'

    onData({
      id,
      data: 'accepted-before-exit',
      providerGeneration: provider.providerGeneration,
      ptyIncarnation: 'incarnation-current'
    })
    onExit({
      id,
      code: 0,
      providerGeneration: provider.providerGeneration,
      ptyIncarnation: 'legacy:31:1:pty-current'
    })
    settleOutput()

    await vi.waitFor(() => expect(provider.settleLivePtyEvidence).toHaveBeenCalledOnce())
    expect(provider.acceptExitedPtyLiveness).toHaveBeenCalledExactlyOnceWith(id)
    expect(provider.acceptLivePty).not.toHaveBeenCalled()
  })

  it('marks a legacy exit unverifiable after current incarnation ownership is known', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    const provider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      onExit: ReturnType<typeof vi.fn>
      acceptAmbiguousExitPty: ReturnType<typeof vi.fn>
    }
    const onExit = provider.onExit.mock.calls[0]?.[0] as (payload: {
      id: string
      code: number
      providerGeneration: number
      ptyIncarnation: string
    }) => void
    vi.mocked(isCurrentPtyExit).mockReturnValueOnce(false)

    onExit({
      id: 'ssh:target-1@@pty-current',
      code: 0,
      providerGeneration: 31,
      ptyIncarnation: 'incarnation-current'
    })

    expect(provider.acceptAmbiguousExitPty).toHaveBeenCalledExactlyOnceWith(
      'ssh:target-1@@pty-current'
    )
    expect(acceptOutputExitMock).not.toHaveBeenCalled()
  })

  it('delivers an exit from a relay that never sends an incarnation', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    const provider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      onExit: ReturnType<typeof vi.fn>
      acceptAmbiguousExitPty: ReturnType<typeof vi.fn>
    }
    const onExit = provider.onExit.mock.calls[0]?.[0] as (payload: {
      id: string
      code: number
      providerGeneration: number
      ptyIncarnation: string
    }) => void

    // No incarnation was ever recorded for this PTY, so isCurrentPtyExit admits the exit.
    onExit({
      id: 'ssh:target-1@@pty-legacy',
      code: 3,
      providerGeneration: 31,
      ptyIncarnation: 'legacy:31:1:pty-legacy'
    })

    await vi.waitFor(() =>
      expect(acceptOutputExitMock).toHaveBeenCalledWith({
        id: 'ssh:target-1@@pty-legacy',
        code: 3,
        providerGeneration: 31,
        ptyIncarnation: 'legacy:31:1:pty-legacy'
      })
    )
    expect(provider.acceptAmbiguousExitPty).not.toHaveBeenCalled()
  })
})
