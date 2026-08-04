import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
} from '../../shared/pty-consumer-session'
import { SshRelaySession } from './ssh-relay-session'
import {
  createMismatchedOwnerRecoveryError,
  createMockDeps
} from './ssh-relay-session-test-fixtures'
import { getSshPtyConsumerRecovery } from './ssh-pty-consumer-recovery'

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
  allocateSshPtyProviderGeneration: vi.fn(() => 23),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  installSshPtySourceAckPublisher: vi.fn(() => () => {}),
  installSshPtySourceCancellationPublisher: vi.fn(() => () => {}),
  applySshPtySourceCancellationProof: vi.fn(),
  applySshPtySourceRecoveryCancellationProof: vi.fn()
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

vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: vi.fn().mockResolvedValue([])
}))

vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: vi.fn().mockReturnValue(false),
  isSshPtyIdentityMismatchError: vi.fn().mockReturnValue(false),
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
  restorePtyIncarnation: vi.fn(),
  setPtyOwnership: vi.fn()
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

const { deployAndLaunchRelay } = await import('./ssh-relay-deploy')
const { clearPtyOwnershipForConnection, unregisterSshPtyProvider } = await import('../ipc/pty')

describe('SshRelaySession consumer recovery durability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockResolvedValue([])
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'negotiated',
      clientInstanceId: options.clientInstanceId,
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'test-owner-lease'
    }))
    vi.mocked(deployAndLaunchRelay).mockResolvedValue({
      transport: { write: vi.fn(), onData: vi.fn(), onClose: vi.fn() },
      platform: 'linux-x64',
      serverBuildId: 'test-relay-build'
    })
  })

  it('holds establish open until the consumer recovery write is durable', async () => {
    const deps = createMockDeps()
    let settleWrite!: () => void
    let signalWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      signalWriteStarted = resolve
    })
    vi.mocked(deps.mockStore.upsertSshPtyConsumerRecovery).mockImplementation(() => {
      signalWriteStarted()
      return new Promise<void>((resolve) => {
        settleWrite = resolve
      })
    })

    const session = new SshRelaySession(
      'durability-barrier-target',
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )
    let established = false
    const establishing = session.establish(deps.mockConn).then(() => {
      established = true
    })

    await writeStarted
    // Why a macrotask, not a microtask count: establish() has several awaits after the write starts,
    // so only yielding past the whole microtask queue proves the write is the thing blocking it.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(established).toBe(false)

    settleWrite()
    await establishing
    expect(established).toBe(true)
    session.dispose()
  })

  it('retries a pending incumbent publication before recovering its persisted lease', async () => {
    vi.useFakeTimers()
    try {
      const targetId = 'target-owner-publication-pending'
      const deps = createMockDeps()
      vi.mocked(deps.mockStore.getSshPtyConsumerRecovery).mockReturnValue({
        targetId,
        clientInstanceId: 'persisted-client',
        serverBuildId: 'test-relay-build',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'persisted-owner'
      })
      openConsumerSessionMock.mockRejectedValueOnce(
        Object.assign(new Error('Owner grant publication is still pending'), {
          code: PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR
        })
      )
      const session = new SshRelaySession(
        targetId,
        deps.getMainWindow,
        deps.mockStore,
        deps.mockPortForward
      )

      const establishing = session.establish(deps.mockConn)
      await vi.advanceTimersByTimeAsync(25)
      await establishing

      expect(openConsumerSessionMock).toHaveBeenCalledTimes(2)
      expect(openConsumerSessionMock.mock.calls[0]?.[1]).toMatchObject({
        clientInstanceId: 'persisted-client',
        resume: { ownerGeneration: 1, ownerLease: 'persisted-owner' }
      })
      session.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves persisted recovery while a superseding transport is still live', async () => {
    vi.useFakeTimers()
    try {
      const targetId = 'target-owner-generation-superseded'
      const deps = createMockDeps()
      vi.mocked(deps.mockStore.getSshPtyConsumerRecovery).mockReturnValue({
        targetId,
        clientInstanceId: 'persisted-client',
        serverBuildId: 'test-relay-build',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'persisted-owner'
      })
      const superseded = Object.assign(new Error('Owner recovery generation was superseded'), {
        code: PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
      })
      openConsumerSessionMock.mockRejectedValue(superseded)
      const session = new SshRelaySession(
        targetId,
        deps.getMainWindow,
        deps.mockStore,
        deps.mockPortForward
      )

      const failed = expect(session.establish(deps.mockConn)).rejects.toBe(superseded)
      await vi.advanceTimersByTimeAsync(3_000)
      await failed

      expect(openConsumerSessionMock.mock.calls.length).toBeGreaterThan(1)
      expect(deps.mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
      session.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps destructive disposal pending until consumer recovery is removed', async () => {
    const { mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId: 'target-disposal-durability',
      clientInstanceId: 'client-disposal-durability',
      serverBuildId: 'test-relay-build',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'owner-lease'
    })
    let settleRemoval!: () => void
    vi.mocked(mockStore.removeSshPtyConsumerRecovery).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          settleRemoval = resolve
        })
    )
    const session = new SshRelaySession(
      'target-disposal-durability',
      getMainWindow,
      mockStore,
      mockPortForward
    )
    let completed = false

    const disposal = session.disposeAndPersist().then(() => {
      completed = true
    })
    await Promise.resolve()

    expect(session.getState()).toBe('disposed')
    expect(completed).toBe(false)
    expect(mockStore.markSshRemotePtyLeases).not.toHaveBeenCalled()
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith(
      'target-disposal-durability',
      'terminated'
    )

    settleRemoval()
    await disposal
    expect(completed).toBe(true)
  })

  it('does not retry a stale owner after disposal wins the recovery-removal race', async () => {
    const targetId = 'target-stale-owner-disposal'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId,
      clientInstanceId: 'persisted-client',
      serverBuildId: 'test-relay-build',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'stale-owner'
    })
    let signalRemovalStarted!: () => void
    const removalStarted = new Promise<void>((resolve) => {
      signalRemovalStarted = resolve
    })
    let settleRemoval!: () => void
    vi.mocked(mockStore.removeSshPtyConsumerRecovery).mockImplementationOnce(() => {
      signalRemovalStarted()
      return new Promise<void>((resolve) => {
        settleRemoval = resolve
      })
    })
    openConsumerSessionMock.mockRejectedValueOnce(createMismatchedOwnerRecoveryError())
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)

    const establishing = session.establish(mockConn)
    const failed = expect(establishing).rejects.toThrow('Session disposed during establish')
    await removalStarted
    const disposal = session.disposeAndPersist()
    settleRemoval()
    await Promise.all([failed, disposal])

    expect(openConsumerSessionMock).toHaveBeenCalledTimes(1)
  })

  it('leaves recovery state alone when a newer owner already claimed the target record', async () => {
    const targetId = 'target-stale-owner-loser'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId,
      clientInstanceId: 'persisted-client',
      serverBuildId: 'test-relay-build',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'stale-owner'
    })
    const winner = {
      mode: 'negotiated' as const,
      clientInstanceId: 'persisted-client',
      clientGeneration: 2,
      ownerGeneration: 5,
      ownerLease: 'winner-owner'
    }
    openConsumerSessionMock.mockImplementationOnce(() => {
      // Why inside the rejection: the record is target-scoped, so the winner can land while this
      // attempt is still unwinding its own resume.
      const record = getSshPtyConsumerRecovery(targetId)!
      record.owner = winner
      record.checkpointsByAppPtyId.set('pty-1', {
        id: 'pty-1'
      } as unknown as never)
      return Promise.reject(createMismatchedOwnerRecoveryError())
    })
    openConsumerSessionMock.mockRejectedValueOnce(new Error('fresh open failed'))
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)

    await expect(session.establish(mockConn)).rejects.toThrow('fresh open failed')

    const record = getSshPtyConsumerRecovery(targetId)!
    expect(record.owner).toBe(winner)
    expect(record.checkpointsByAppPtyId.has('pty-1')).toBe(true)
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    session.dispose()
  })

  it('does not remember a consumer opened after establish was disposed', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    let signalOpenStarted!: () => void
    const openStarted = new Promise<void>((resolve) => {
      signalOpenStarted = resolve
    })
    let finishOpen!: (value: unknown) => void
    openConsumerSessionMock.mockImplementationOnce(() => {
      signalOpenStarted()
      return new Promise((resolve) => {
        finishOpen = resolve
      })
    })
    const session = new SshRelaySession(
      'target-open-disposal',
      getMainWindow,
      mockStore,
      mockPortForward
    )

    const establishing = session.establish(mockConn)
    const failed = expect(establishing).rejects.toThrow('Session disposed during establish')
    await openStarted
    await session.disposeAndPersist()
    finishOpen({
      mode: 'negotiated',
      clientInstanceId: 'late-client',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'late-owner'
    })
    await failed

    expect(mockStore.upsertSshPtyConsumerRecovery).not.toHaveBeenCalled()
  })

  it('upgrades a pending detach to a full disposal', async () => {
    const targetId = 'target-teardown-upgrade'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    let settleDetachPersistence!: () => void
    let settleDisposalPersistence!: () => void
    vi.mocked(mockStore.markSshRemotePtyLeasesAsync)
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settleDetachPersistence = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settleDisposalPersistence = resolve
          })
      )
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    let detachCompleted = false
    const detach = session.detachAndPersist().then(() => {
      detachCompleted = true
    })
    const disposal = session.disposeAndPersist()

    // Why: dispose supersedes the in-flight detach, so the destructive half must still run.
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith(targetId, 'terminated')
    expect(getSshPtyConsumerRecovery(targetId)).toBeUndefined()
    // Why: 'shutdown' teardown, not detach's 'connection_lost' — PTY ownership is released for good.
    expect(clearPtyOwnershipForConnection).toHaveBeenCalledWith(targetId)

    settleDetachPersistence()
    await Promise.resolve()
    await Promise.resolve()
    expect(detachCompleted).toBe(false)
    settleDisposalPersistence()
    await Promise.all([detach, disposal])

    // Why: the reverse order is not an upgrade — a detach after disposal must not re-open ownership.
    vi.mocked(mockStore.markSshRemotePtyLeasesAsync).mockClear()
    await session.detachAndPersist()
    expect(mockStore.markSshRemotePtyLeasesAsync).not.toHaveBeenCalled()
  })

  it('re-issues only the lease write after a rejected detach persistence', async () => {
    const targetId = 'target-detach-write-retry'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.markSshRemotePtyLeasesAsync).mockRejectedValueOnce(
      new Error('lease write failed')
    )
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.mocked(clearPtyOwnershipForConnection).mockClear()

    await expect(session.detachAndPersist()).rejects.toThrow('lease write failed')

    const teardownCalls = vi.mocked(unregisterSshPtyProvider).mock.calls.length
    vi.mocked(mockStore.markSshRemotePtyLeasesAsync).mockClear()
    await session.detachAndPersist()

    // Why: the retry re-issues the write only — re-running provider teardown would tear down
    // whatever a replacement session has already registered for this target.
    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith(targetId, 'detached')
    expect(unregisterSshPtyProvider).toHaveBeenCalledTimes(teardownCalls)
    expect(clearPtyOwnershipForConnection).not.toHaveBeenCalled()
  })

  it('still upgrades to disposal after a rejected detach persistence', async () => {
    const targetId = 'target-detach-write-failure-disposal'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.markSshRemotePtyLeasesAsync).mockRejectedValueOnce(
      new Error('lease write failed')
    )
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    await expect(session.detachAndPersist()).rejects.toThrow('lease write failed')
    await session.disposeAndPersist()

    expect(mockStore.markSshRemotePtyLeasesAsync).toHaveBeenCalledWith(targetId, 'terminated')
    expect(getSshPtyConsumerRecovery(targetId)).toBeUndefined()
  })
})
