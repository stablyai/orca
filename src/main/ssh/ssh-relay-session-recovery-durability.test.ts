import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR,
  PTY_CONSUMER_OWNER_HELD_SELF_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_PENDING_ERROR,
  PTY_CONSUMER_OWNER_RECOVERY_SUPERSEDED_ERROR
} from '../../shared/pty-consumer-session'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps } from './ssh-relay-session-test-fixtures'
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
      state: {
        mode: 'negotiated',
        clientInstanceId: options.clientInstanceId,
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'test-owner-lease'
      },
      resumed: false
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

  it('reports an attached owner as terminal instead of a lost relay', async () => {
    const targetId = 'target-owner-held-attached'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    const onTerminal = vi.fn()
    const onRelayLost = vi.fn()
    session.setOnTerminalRelayError(onTerminal)
    session.setOnRelayLost(onRelayLost)
    await session.establish(mockConn)

    openConsumerSessionMock.mockRejectedValueOnce(
      Object.assign(new Error('PTY session owner is held by an attached connection'), {
        code: PTY_CONSUMER_OWNER_HELD_ATTACHED_ERROR
      })
    )
    await session.reconnect(mockConn)

    // Why not relay-lost: the relay answered and refused on purpose, so redeploy backoff would spend
    // its whole budget on a link that is working.
    expect(onRelayLost).not.toHaveBeenCalled()
    expect(onTerminal).toHaveBeenCalledWith(
      targetId,
      expect.objectContaining({ name: 'SshOwnerAdmissionBlockedError' })
    )
    expect(onTerminal.mock.calls[0]?.[1]?.message).toContain('owns the remote terminals')
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    expect(openConsumerSessionMock).toHaveBeenCalledTimes(2)
    session.dispose()
  })

  it("routes this client's own attached connection to relay-lost recovery, not to a parked error", async () => {
    const targetId = 'target-owner-held-self'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    const onTerminal = vi.fn()
    const onRelayLost = vi.fn()
    session.setOnTerminalRelayError(onTerminal)
    session.setOnRelayLost(onRelayLost)
    await session.establish(mockConn)

    // The incumbent is this app's own half-open connection, which the relay has not yet observed
    // closing — the ordinary single-app case, since only SshRelaySession ever requests session-owner.
    openConsumerSessionMock.mockRejectedValue(
      Object.assign(
        new Error("PTY session owner is held by this client's own earlier connection"),
        {
          code: PTY_CONSUMER_OWNER_HELD_SELF_ERROR
        }
      )
    )
    await session.reconnect(mockConn)

    // Why not terminal: parking here clears backoff and never retries, so the user stays locked out
    // of their own session until they restart the app. Backoff is what lets keepalive reap the zombie.
    expect(onTerminal).not.toHaveBeenCalled()
    expect(onRelayLost).toHaveBeenCalled()
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    session.dispose()
  })

  it('recovers a forgotten owner record in one request without deleting recovery identity', async () => {
    const targetId = 'target-forgotten-owner-record'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId,
      clientInstanceId: 'persisted-client',
      serverBuildId: 'test-relay-build',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'forgotten-owner'
    })
    openConsumerSessionMock.mockImplementationOnce(async () => ({
      state: {
        mode: 'negotiated',
        clientInstanceId: 'persisted-client',
        clientGeneration: 4,
        ownerGeneration: 9,
        ownerLease: 'fresh-owner'
      },
      resumed: false
    }))
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    getSshPtyConsumerRecovery(targetId)!.checkpointsByAppPtyId.set('pty-1', {
      id: 'pty-1'
    } as unknown as never)

    await session.establish(mockConn)

    expect(openConsumerSessionMock).toHaveBeenCalledTimes(1)
    expect(openConsumerSessionMock.mock.calls[0]?.[1]).toMatchObject({
      resume: { ownerGeneration: 1, ownerLease: 'forgotten-owner' }
    })
    // Why both: the fresh claim voids checkpoints taken under the old lease, but the recovery identity
    // is what lets this client keep resuming the target at all — a refusal must never cost it.
    expect(getSshPtyConsumerRecovery(targetId)!.checkpointsByAppPtyId.size).toBe(0)
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    expect(mockStore.upsertSshPtyConsumerRecovery).toHaveBeenCalledWith(
      expect.objectContaining({
        targetId,
        clientInstanceId: 'persisted-client',
        ownerGeneration: 9,
        ownerLease: 'fresh-owner'
      })
    )
    session.dispose()
  })

  it('keeps checkpoints when a resumed claim comes back', async () => {
    const targetId = 'target-resumed-owner-record'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId,
      clientInstanceId: 'persisted-client',
      serverBuildId: 'test-relay-build',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'persisted-owner'
    })
    openConsumerSessionMock.mockImplementationOnce(async () => ({
      state: {
        mode: 'negotiated',
        clientInstanceId: 'persisted-client',
        clientGeneration: 4,
        ownerGeneration: 2,
        ownerLease: 'persisted-owner'
      },
      resumed: true
    }))
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    getSshPtyConsumerRecovery(targetId)!.checkpointsByAppPtyId.set('pty-1', {
      id: 'pty-1'
    } as unknown as never)

    await session.establish(mockConn)

    expect(getSshPtyConsumerRecovery(targetId)!.checkpointsByAppPtyId.has('pty-1')).toBe(true)
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    session.dispose()
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
    openConsumerSessionMock.mockImplementationOnce(async () => {
      // Why inside the open: the record is target-scoped, so the winner can land while this attempt is
      // still waiting on its own resume, leaving this attempt's `previousOwner` snapshot stale.
      const record = getSshPtyConsumerRecovery(targetId)!
      record.owner = winner
      record.checkpointsByAppPtyId.set('pty-1', { id: 'pty-1' } as unknown as never)
      return {
        state: {
          mode: 'negotiated',
          clientInstanceId: 'persisted-client',
          clientGeneration: 3,
          ownerGeneration: 1,
          ownerLease: 'loser-owner'
        },
        resumed: false
      }
    })
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(getSshPtyConsumerRecovery(targetId)!.checkpointsByAppPtyId.has('pty-1')).toBe(true)
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    session.dispose()
  })

  it('mutates no recovery state after a local attempt loses its authority', async () => {
    const targetId = 'target-owner-attempt-superseded'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId,
      clientInstanceId: 'persisted-client',
      serverBuildId: 'test-relay-build',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'persisted-owner'
    })
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
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    getSshPtyConsumerRecovery(targetId)!.checkpointsByAppPtyId.set('pty-1', {
      id: 'pty-1'
    } as unknown as never)

    const superseded = session.establish(mockConn)
    const failed = expect(superseded).rejects.toThrow('Session disposed during establish')
    await openStarted
    // Why detach and not disposal: disposal legitimately removes the record, which would hide whether
    // the attempt that lost its authority mutated anything on its way out.
    await session.detachAndPersist()
    finishOpen({
      state: {
        mode: 'negotiated',
        clientInstanceId: 'persisted-client',
        clientGeneration: 3,
        ownerGeneration: 3,
        ownerLease: 'superseded-owner'
      },
      resumed: false
    })
    await failed

    expect(getSshPtyConsumerRecovery(targetId)!.checkpointsByAppPtyId.has('pty-1')).toBe(true)
    expect(mockStore.upsertSshPtyConsumerRecovery).not.toHaveBeenCalledWith(
      expect.objectContaining({ ownerLease: 'superseded-owner' })
    )
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
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
      state: {
        mode: 'negotiated',
        clientInstanceId: 'late-client',
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'late-owner'
      },
      resumed: false
    })
    await failed

    expect(mockStore.upsertSshPtyConsumerRecovery).not.toHaveBeenCalled()
  })

  it('detaches for shutdown in memory without a per-session durable write', async () => {
    const targetId = 'target-shutdown-detach'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)
    vi.mocked(mockStore.markSshRemotePtyLeasesAsync).mockClear()

    session.beginShutdownDetach()
    session.beginShutdownDetach()

    // Why in-memory only: the committed quit path runs the final store flush immediately after this,
    // and a durable write here would race that flush rather than be captured by it.
    expect(mockStore.markSshRemotePtyLeasesForShutdown).toHaveBeenCalledExactlyOnceWith(
      targetId,
      'detached'
    )
    expect(mockStore.markSshRemotePtyLeasesAsync).not.toHaveBeenCalled()
    // Why the recovery record survives: 'detached' means this app let go, not that the remote shell
    // died — the identity is what lets the next launch reattach those still-running PTYs.
    expect(mockStore.removeSshPtyConsumerRecovery).not.toHaveBeenCalled()
    expect(getSshPtyConsumerRecovery(targetId)?.detached).toBe(true)
    expect(getSshPtyConsumerRecovery(targetId)?.clientInstanceId).toBeTypeOf('string')
  })

  it('keeps ordinary detach durability reporting unchanged after a shutdown detach exists', async () => {
    const targetId = 'target-shutdown-vs-ordinary-detach'
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.markSshRemotePtyLeasesAsync).mockRejectedValueOnce(
      new Error('lease write failed')
    )
    const session = new SshRelaySession(targetId, getMainWindow, mockStore, mockPortForward)
    await session.establish(mockConn)

    // Why still rejecting: only the shutdown path delegates durability; an ordinary detach must keep
    // surfacing a failed write to its caller.
    await expect(session.detachAndPersist()).rejects.toThrow('lease write failed')
    expect(mockStore.markSshRemotePtyLeasesForShutdown).not.toHaveBeenCalled()
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
