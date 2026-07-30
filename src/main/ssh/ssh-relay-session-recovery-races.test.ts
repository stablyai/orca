import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const {
  acceptOutputDataMock,
  acceptOutputExitMock,
  muxRequestMock,
  onNotificationByMethodMock,
  openConsumerSessionMock,
  muxDisposeMock,
  ptyProviderDisposeMock,
  sourceAckCleanupMock,
  sourceCancellationCleanupMock,
  attachForReconnectMock,
  ptyDataHandlerRef,
  ptyExitHandlerRef
} = vi.hoisted(() => ({
  acceptOutputDataMock: vi.fn().mockResolvedValue(undefined),
  acceptOutputExitMock: vi.fn().mockResolvedValue(undefined),
  muxRequestMock: vi.fn(),
  onNotificationByMethodMock: vi.fn(),
  openConsumerSessionMock: vi.fn(),
  muxDisposeMock: vi.fn(),
  ptyProviderDisposeMock: vi.fn(),
  sourceAckCleanupMock: vi.fn(),
  sourceCancellationCleanupMock: vi.fn(),
  attachForReconnectMock: vi.fn().mockResolvedValue({}),
  ptyDataHandlerRef: { current: undefined as undefined | ((payload: unknown) => void) },
  ptyExitHandlerRef: { current: undefined as undefined | ((payload: unknown) => void) }
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: acceptOutputDataMock,
  acceptSshPtyOutputExit: acceptOutputExitMock,
  allocateSshPtyProviderGeneration: vi.fn(() => 23),
  beginSshPtyOutputGenerationMigration: vi.fn(() => ({
    byPty: new Map(),
    completion: Promise.resolve()
  })),
  closeSshPtyOutputGeneration: vi.fn(),
  getSshPtyAcceptedSourceCheckpoints: vi.fn(() => []),
  installSshPtySourceAckPublisher: vi.fn(() => sourceAckCleanupMock),
  installSshPtySourceCancellationPublisher: vi.fn(() => sourceCancellationCleanupMock),
  applySshPtySourceCancellationProof: vi.fn(() => true),
  applySshPtySourceRecoveryCancellationProof: vi.fn(() => true)
}))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = onNotificationByMethodMock.mockImplementation(() => () => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = muxDisposeMock
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: vi.fn().mockReturnValue(false),
  isSshPtyIdentityMismatchError: vi.fn().mockReturnValue(false),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockImplementation((handler) => {
      ptyDataHandlerRef.current = handler
      return () => {}
    })
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockImplementation((handler) => {
      ptyExitHandlerRef.current = handler
      return () => {}
    })
    attachForReconnect = attachForReconnectMock
    setPtyDeliveryPauseAdapter = vi.fn()
    dispose = ptyProviderDisposeMock
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
  isCurrentPtyExit: vi.fn(() => true),
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

const {
  clearProviderPtyState,
  clearPtyOwnershipForConnection,
  deletePtyOwnership,
  getSshPtyProvider,
  getPtyIdsForConnection,
  registerSshPtyProvider,
  setPtyOwnership,
  unregisterSshPtyProvider
} = await import('../ipc/pty')
const { closeSshPtyOutputGeneration, getSshPtyAcceptedSourceCheckpoints } =
  await import('../ipc/ssh-pty-output-intake-registry')
const { applySshPtySourceCancellationProof } = await import('../ipc/ssh-pty-output-intake-registry')
const { applySshPtySourceRecoveryCancellationProof } =
  await import('../ipc/ssh-pty-output-intake-registry')

describe('SshRelaySession recovery race fencing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ptyDataHandlerRef.current = undefined
    ptyExitHandlerRef.current = undefined
    attachForReconnectMock.mockResolvedValue({})
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReturnValue([])
    vi.mocked(applySshPtySourceCancellationProof).mockReturnValue(true)
    vi.mocked(applySshPtySourceRecoveryCancellationProof).mockReturnValue(true)
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
  })

  function emitSourceFrame(args: {
    targetId: string
    token: string
    clientGeneration: number
    ownerGeneration: number
    sourceStartSu: number
    sourceEndSu: number
  }): void {
    ptyDataHandlerRef.current?.({
      id: `ssh:${args.targetId}@@pty-1`,
      data: 'late',
      providerGeneration: 23,
      ptyIncarnation: 'incarnation-1',
      sequenceChars: args.sourceEndSu - args.sourceStartSu,
      source: {
        relayPtyId: 'pty-1',
        spanId: `${args.token}:${args.sourceStartSu}:${args.sourceEndSu}`,
        clientGeneration: args.clientGeneration,
        ownerGeneration: args.ownerGeneration,
        deliveryToken: args.token,
        sourceStartSu: args.sourceStartSu,
        sourceEndSu: args.sourceEndSu
      }
    })
  }

  async function prepareRecovery(targetId: string): Promise<{
    session: SshRelaySession
    deps: ReturnType<typeof createMockDeps>
  }> {
    let generation = 0
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      mode: 'negotiated',
      clientInstanceId: options.clientInstanceId,
      clientGeneration: ++generation,
      ownerGeneration: generation,
      ownerLease: `owner-lease-${generation}`,
      outputFlowControl: { version: 1, windowSu: 256 * 1024 }
    }))
    vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReturnValue([
      {
        id: `ssh:${targetId}@@pty-1`,
        providerGeneration: 23,
        clientGeneration: 1,
        ownerGeneration: 1,
        ptyIncarnation: 'incarnation-1',
        deliveryToken: 'old-token',
        acceptedSourceEndSu: 4
      }
    ])
    const deps = createMockDeps()
    const session = new SshRelaySession(
      targetId,
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )
    await session.establish(deps.mockConn)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([`ssh:${targetId}@@pty-1`])
    vi.mocked(getSshPtyProvider).mockImplementation(
      () => vi.mocked(registerSshPtyProvider).mock.calls.at(-1)?.[1]
    )
    return { session, deps }
  }

  it('publishes held recovery data before an exact exit without waiting for completion', async () => {
    const targetId = 'exit-with-complete-private-body'
    const { session, deps } = await prepareRecovery(targetId)
    const recoveryActivationLease = { commit: vi.fn(), retire: vi.fn() }
    const sourceActivationLease = {
      commit: vi.fn(),
      rollback: vi.fn(async () => true),
      transferToRecovery: vi.fn((sink: (payload: unknown) => void) => {
        sink({
          id: `ssh:${targetId}@@pty-1`,
          data: 'held',
          providerGeneration: 23,
          ptyIncarnation: 'incarnation-1',
          sequenceChars: 4,
          source: {
            relayPtyId: 'pty-1',
            spanId: 'new-token:4:8',
            clientGeneration: 2,
            ownerGeneration: 2,
            deliveryToken: 'new-token',
            sourceStartSu: 4,
            sourceEndSu: 8
          }
        })
        return recoveryActivationLease
      })
    }
    attachForReconnectMock.mockImplementation(async () => {
      ptyExitHandlerRef.current?.({
        id: `ssh:${targetId}@@pty-1`,
        code: 0,
        providerGeneration: 23,
        ptyIncarnation: 'incarnation-1',
        incarnationId: 'incarnation-1'
      })
      return {
        incarnationId: 'incarnation-1',
        sourceRecovery: {
          status: 'pending',
          clientGeneration: 2,
          ownerGeneration: 2,
          ptyIncarnation: 'incarnation-1',
          deliveryToken: 'new-token',
          checkpointSourceEndSu: 4,
          recoveryEndSu: 8
        },
        sourceActivationLease
      }
    })

    await session.reconnect(deps.mockConn)

    expect(acceptOutputDataMock).toHaveBeenCalledWith(expect.objectContaining({ data: 'held' }))
    expect(acceptOutputExitMock).toHaveBeenCalledOnce()
    expect(acceptOutputDataMock.mock.invocationCallOrder[0]).toBeLessThan(
      acceptOutputExitMock.mock.invocationCallOrder[0]!
    )
    expect(sourceActivationLease.transferToRecovery).toHaveBeenCalledOnce()
    expect(sourceActivationLease.rollback).not.toHaveBeenCalled()
    expect(recoveryActivationLease.commit).toHaveBeenCalledOnce()
    expect(recoveryActivationLease.retire).not.toHaveBeenCalled()
    expect(muxRequestMock).not.toHaveBeenCalledWith('pty.cancelDelivery', expect.anything())
    expect(setPtyOwnership).not.toHaveBeenCalled()
    expect(deps.mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      targetId,
      'pty-1',
      'attached'
    )
  })

  it('settles exact cancellation before publishing an exit with incomplete recovery data', async () => {
    const targetId = 'exit-with-incomplete-private-body'
    let settleCancellation: ((proof: unknown) => void) | undefined
    muxRequestMock.mockImplementation((method) =>
      method === 'pty.cancelDelivery'
        ? new Promise((resolve) => {
            settleCancellation = resolve
          })
        : Promise.resolve([])
    )
    const { session, deps } = await prepareRecovery(targetId)
    const recoveryActivationLease = { commit: vi.fn(), retire: vi.fn() }
    const sourceActivationLease = {
      commit: vi.fn(),
      rollback: vi.fn(async () => true),
      transferToRecovery: vi.fn((sink: (payload: unknown) => void) => {
        sink({
          id: `ssh:${targetId}@@pty-1`,
          data: 'partial',
          providerGeneration: 23,
          ptyIncarnation: 'incarnation-1',
          sequenceChars: 2,
          source: {
            relayPtyId: 'pty-1',
            spanId: 'new-token:4:6',
            clientGeneration: 2,
            ownerGeneration: 2,
            deliveryToken: 'new-token',
            sourceStartSu: 4,
            sourceEndSu: 6
          }
        })
        return recoveryActivationLease
      })
    }
    attachForReconnectMock.mockImplementation(async () => {
      ptyExitHandlerRef.current?.({
        id: `ssh:${targetId}@@pty-1`,
        code: 0,
        providerGeneration: 23,
        ptyIncarnation: 'incarnation-1',
        incarnationId: 'incarnation-1'
      })
      return {
        incarnationId: 'incarnation-1',
        sourceRecovery: {
          status: 'pending',
          clientGeneration: 2,
          ownerGeneration: 2,
          ptyIncarnation: 'incarnation-1',
          deliveryToken: 'new-token',
          checkpointSourceEndSu: 4,
          recoveryEndSu: 8
        },
        sourceActivationLease
      }
    })

    const reconnect = session.reconnect(deps.mockConn)
    await vi.waitFor(() =>
      expect(muxRequestMock).toHaveBeenCalledWith('pty.cancelDelivery', {
        id: 'pty-1',
        clientGeneration: 2,
        ownerGeneration: 2,
        deliveryToken: 'new-token'
      })
    )
    expect(acceptOutputExitMock).not.toHaveBeenCalled()

    settleCancellation?.({ canceled: true, sentEndSu: 6, creditedEndSu: 4 })
    await reconnect

    expect(acceptOutputDataMock).not.toHaveBeenCalled()
    expect(acceptOutputExitMock).toHaveBeenCalledOnce()
    expect(recoveryActivationLease.commit).not.toHaveBeenCalled()
    expect(recoveryActivationLease.retire).toHaveBeenCalledOnce()
    expect(sourceActivationLease.rollback).not.toHaveBeenCalled()
    expect(applySshPtySourceRecoveryCancellationProof).toHaveBeenCalledOnce()
  })

  it('awaits provisional cancellation proof before publishing an exact recovery exit', async () => {
    const targetId = 'exit-before-recovery-identity'
    let settleRollback: ((settled: boolean) => void) | undefined
    const { session, deps } = await prepareRecovery(targetId)
    const sourceActivationLease = {
      commit: vi.fn(),
      rollback: vi.fn(
        () =>
          new Promise<boolean>((resolve) => {
            settleRollback = resolve
          })
      ),
      transferToRecovery: vi.fn()
    }
    attachForReconnectMock.mockImplementation(async () => {
      ptyExitHandlerRef.current?.({
        id: `ssh:${targetId}@@pty-1`,
        code: 0,
        providerGeneration: 23,
        ptyIncarnation: 'incarnation-1',
        incarnationId: 'incarnation-1'
      })
      return {
        incarnationId: 'incarnation-1',
        sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' },
        sourceActivationLease
      }
    })

    const reconnect = session.reconnect(deps.mockConn)
    await vi.waitFor(() => expect(sourceActivationLease.rollback).toHaveBeenCalledOnce())
    expect(acceptOutputExitMock).not.toHaveBeenCalled()

    settleRollback?.(true)
    await reconnect

    expect(acceptOutputExitMock).toHaveBeenCalledOnce()
    expect(sourceActivationLease.transferToRecovery).not.toHaveBeenCalled()
    expect(sourceActivationLease.commit).not.toHaveBeenCalled()
  })

  it('retains the empty recovery end as the first post-activation source anchor', async () => {
    const targetId = 'empty-recovery-gap'
    const { session, deps } = await prepareRecovery(targetId)
    attachForReconnectMock.mockImplementation(async () => {
      queueMicrotask(() => {
        const complete = onNotificationByMethodMock.mock.calls.findLast(
          ([method]) => method === 'pty.recoveryComplete'
        )?.[1] as ((params: Record<string, unknown>) => void) | undefined
        complete?.({
          id: 'pty-1',
          clientGeneration: 2,
          ownerGeneration: 2,
          ptyIncarnation: 'incarnation-1',
          deliveryToken: 'new-token',
          checkpointSourceEndSu: 4,
          recoveryEndSu: 4
        })
      })
      return {
        incarnationId: 'incarnation-1',
        sourceRecovery: {
          status: 'pending',
          clientGeneration: 2,
          ownerGeneration: 2,
          ptyIncarnation: 'incarnation-1',
          deliveryToken: 'new-token',
          checkpointSourceEndSu: 4,
          recoveryEndSu: 4
        }
      }
    })
    await session.reconnect(deps.mockConn)
    const closeCount = vi.mocked(closeSshPtyOutputGeneration).mock.calls.length

    emitSourceFrame({
      targetId,
      token: 'new-token',
      clientGeneration: 2,
      ownerGeneration: 2,
      sourceStartSu: 5,
      sourceEndSu: 8
    })

    expect(acceptOutputDataMock).not.toHaveBeenCalled()
    expect(closeSshPtyOutputGeneration).toHaveBeenCalledTimes(closeCount + 1)
    expect(closeSshPtyOutputGeneration).toHaveBeenLastCalledWith(
      23,
      'ssh_source_frame_stale_or_non_contiguous'
    )
  })

  it('drops late frames from a token after its cancellation proof is validated', async () => {
    const targetId = 'late-after-cancel'
    muxRequestMock.mockImplementation(async (method) =>
      method === 'pty.cancelDelivery' ? { canceled: true, sentEndSu: 8, creditedEndSu: 4 } : []
    )
    const { session, deps } = await prepareRecovery(targetId)
    attachForReconnectMock.mockImplementation(async () => {
      queueMicrotask(() => {
        emitSourceFrame({
          targetId,
          token: 'new-token',
          clientGeneration: 2,
          ownerGeneration: 2,
          sourceStartSu: 5,
          sourceEndSu: 8
        })
        const complete = onNotificationByMethodMock.mock.calls.findLast(
          ([method]) => method === 'pty.recoveryComplete'
        )?.[1] as ((params: Record<string, unknown>) => void) | undefined
        complete?.({
          id: 'pty-1',
          clientGeneration: 2,
          ownerGeneration: 2,
          ptyIncarnation: 'incarnation-1',
          deliveryToken: 'new-token',
          checkpointSourceEndSu: 4,
          recoveryEndSu: 8
        })
      })
      return {
        incarnationId: 'incarnation-1',
        sourceRecovery: {
          status: 'pending',
          clientGeneration: 2,
          ownerGeneration: 2,
          ptyIncarnation: 'incarnation-1',
          deliveryToken: 'new-token',
          checkpointSourceEndSu: 4,
          recoveryEndSu: 8
        }
      }
    })
    await session.reconnect(deps.mockConn)
    const closeCount = vi.mocked(closeSshPtyOutputGeneration).mock.calls.length

    emitSourceFrame({
      targetId,
      token: 'new-token',
      clientGeneration: 2,
      ownerGeneration: 2,
      sourceStartSu: 8,
      sourceEndSu: 12
    })

    expect(acceptOutputDataMock).not.toHaveBeenCalled()
    expect(closeSshPtyOutputGeneration).toHaveBeenCalledTimes(closeCount)
    expect(deps.mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(targetId, 'pty-1', 'detached')
    expect(clearProviderPtyState).not.toHaveBeenCalled()
    expect(clearPtyOwnershipForConnection).not.toHaveBeenCalled()
    expect(deletePtyOwnership).not.toHaveBeenCalled()
    expect(deps.mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())
    expect(muxDisposeMock).not.toHaveBeenCalledWith('shutdown')
  })

  it('rejects cancellation proof below capacity-rejected and later private frames', async () => {
    const targetId = 'capacity-watermark'
    muxRequestMock.mockImplementation(async (method) =>
      method === 'pty.cancelDelivery' ? { canceled: true, sentEndSu: 8, creditedEndSu: 4 } : []
    )
    const { session, deps } = await prepareRecovery(targetId)
    const recoveryActivationLease = { commit: vi.fn(), retire: vi.fn() }
    const sourceActivationLease = {
      commit: vi.fn(),
      rollback: vi.fn(),
      transferToRecovery: vi.fn((sink: (payload: unknown) => void) => {
        sink({
          id: `ssh:${targetId}@@pty-1`,
          data: 'x'.repeat(2 * 1024 * 1024 + 1),
          providerGeneration: 23,
          ptyIncarnation: 'incarnation-1',
          sequenceChars: 4,
          source: {
            relayPtyId: 'pty-1',
            spanId: 'new-token:4:8',
            clientGeneration: 2,
            ownerGeneration: 2,
            deliveryToken: 'new-token',
            sourceStartSu: 4,
            sourceEndSu: 8
          }
        })
        sink({
          id: `ssh:${targetId}@@pty-1`,
          data: 'later',
          providerGeneration: 23,
          ptyIncarnation: 'incarnation-1',
          sequenceChars: 4,
          source: {
            relayPtyId: 'pty-1',
            spanId: 'new-token:8:12',
            clientGeneration: 2,
            ownerGeneration: 2,
            deliveryToken: 'new-token',
            sourceStartSu: 8,
            sourceEndSu: 12
          }
        })
        return recoveryActivationLease
      })
    }
    attachForReconnectMock.mockResolvedValue({
      incarnationId: 'incarnation-1',
      sourceRecovery: {
        status: 'pending',
        clientGeneration: 2,
        ownerGeneration: 2,
        ptyIncarnation: 'incarnation-1',
        deliveryToken: 'new-token',
        checkpointSourceEndSu: 4,
        recoveryEndSu: 12
      },
      sourceActivationLease
    })

    await session.reconnect(deps.mockConn)

    expect(muxRequestMock).toHaveBeenCalledWith(
      'pty.cancelDelivery',
      expect.objectContaining({ deliveryToken: 'new-token' })
    )
    expect(vi.mocked(closeSshPtyOutputGeneration).mock.calls).toContainEqual([
      23,
      'ssh_source_recovery_cancellation_failed'
    ])
    expect(applySshPtySourceRecoveryCancellationProof).not.toHaveBeenCalled()
    expect(recoveryActivationLease.commit).not.toHaveBeenCalled()
    expect(recoveryActivationLease.retire).toHaveBeenCalledOnce()
  })

  it.each([
    ['publication', undefined],
    ['proof', { canceled: true, sentEndSu: 8, creditedEndSu: 4 }],
    ['negative-end', { canceled: true, sentEndSu: -1, creditedEndSu: 4 }],
    ['credited-ahead', { canceled: true, sentEndSu: 8, creditedEndSu: 9 }],
    ['checkpoint-mismatch', { canceled: true, sentEndSu: 8, creditedEndSu: 3 }],
    ['sent-before-private-end', { canceled: true, sentEndSu: 7, creditedEndSu: 4 }]
  ] as const)(
    'closes one provider generation when recovery cancellation %s rejects',
    async (failure, cancellationResult) => {
      const targetId = `cancel-${failure}-failure`
      muxRequestMock.mockImplementation(async (method) => {
        if (method !== 'pty.cancelDelivery') {
          return []
        }
        if (failure === 'publication') {
          throw new Error('cancel publication failed')
        }
        return cancellationResult
      })
      if (failure === 'proof') {
        vi.mocked(applySshPtySourceRecoveryCancellationProof).mockImplementation(() => {
          throw new Error('cancel proof rejected')
        })
      }
      const { session, deps } = await prepareRecovery(targetId)
      const onRelayLost = vi.fn()
      const recoveryActivationLease = { commit: vi.fn(), retire: vi.fn() }
      const activationLease = {
        commit: vi.fn(),
        rollback: vi.fn(),
        transferToRecovery: vi.fn(() => recoveryActivationLease)
      }
      session.setOnRelayLost(onRelayLost)
      let cleanupCountsBeforeFailure:
        | {
            generation: number
            mux: number
            provider: number
            ack: number
            cancellation: number
            unregister: number
          }
        | undefined
      attachForReconnectMock.mockImplementation(async () => {
        cleanupCountsBeforeFailure = {
          generation: vi.mocked(closeSshPtyOutputGeneration).mock.calls.length,
          mux: muxDisposeMock.mock.calls.length,
          provider: ptyProviderDisposeMock.mock.calls.length,
          ack: sourceAckCleanupMock.mock.calls.length,
          cancellation: sourceCancellationCleanupMock.mock.calls.length,
          unregister: vi.mocked(unregisterSshPtyProvider).mock.calls.length
        }
        queueMicrotask(() => {
          emitSourceFrame({
            targetId,
            token: 'new-token',
            clientGeneration: 2,
            ownerGeneration: 2,
            sourceStartSu: 5,
            sourceEndSu: 8
          })
        })
        return {
          incarnationId: 'incarnation-1',
          sourceRecovery: {
            status: 'pending',
            clientGeneration: 2,
            ownerGeneration: 2,
            ptyIncarnation: 'incarnation-1',
            deliveryToken: 'new-token',
            checkpointSourceEndSu: 4,
            recoveryEndSu: 8
          },
          sourceActivationLease: activationLease
        }
      })

      await session.reconnect(deps.mockConn)

      expect(cleanupCountsBeforeFailure).toBeDefined()
      const before = cleanupCountsBeforeFailure!
      expect(vi.mocked(closeSshPtyOutputGeneration).mock.calls).toHaveLength(before.generation + 1)
      expect(closeSshPtyOutputGeneration).toHaveBeenLastCalledWith(
        23,
        'ssh_source_recovery_cancellation_failed'
      )
      expect(muxDisposeMock.mock.calls).toHaveLength(before.mux + 1)
      expect(muxDisposeMock).toHaveBeenLastCalledWith('connection_lost')
      expect(ptyProviderDisposeMock.mock.calls).toHaveLength(before.provider + 1)
      expect(sourceAckCleanupMock.mock.calls).toHaveLength(before.ack + 1)
      expect(sourceCancellationCleanupMock.mock.calls).toHaveLength(before.cancellation + 1)
      expect(vi.mocked(unregisterSshPtyProvider).mock.calls).toHaveLength(before.unregister + 1)
      expect(unregisterSshPtyProvider).toHaveBeenLastCalledWith(targetId)
      expect(activationLease.transferToRecovery).toHaveBeenCalledOnce()
      expect(activationLease.commit).not.toHaveBeenCalled()
      expect(activationLease.rollback).not.toHaveBeenCalled()
      expect(recoveryActivationLease.commit).not.toHaveBeenCalled()
      expect(recoveryActivationLease.retire).toHaveBeenCalledOnce()
      expect(onRelayLost).toHaveBeenCalledOnce()
      expect(session.getState()).toBe('reconnecting')
      expect(clearProviderPtyState).not.toHaveBeenCalled()
      expect(clearPtyOwnershipForConnection).not.toHaveBeenCalled()
      expect(deletePtyOwnership).not.toHaveBeenCalled()
      expect(deps.mockStore.markSshRemotePtyLease).not.toHaveBeenCalled()
      expect(deps.mockWindow.webContents.send).not.toHaveBeenCalledWith(
        'pty:exit',
        expect.anything()
      )
      expect(muxDisposeMock).not.toHaveBeenCalledWith('shutdown')
      expect(vi.mocked(closeSshPtyOutputGeneration).mock.calls).not.toContainEqual([
        99,
        expect.anything()
      ])
      expect(unregisterSshPtyProvider).not.toHaveBeenCalledWith('unrelated-target')
    }
  )

  it('keeps a stale overlapping recovery from canceling or mutating its replacement', async () => {
    const targetId = 'overlapping-recovery'
    const { session, deps } = await prepareRecovery(targetId)
    const staleRecoveryLease = { commit: vi.fn(), retire: vi.fn() }
    const replacementRecoveryLease = { commit: vi.fn(), retire: vi.fn() }
    const staleLease = {
      commit: vi.fn(),
      rollback: vi.fn(),
      transferToRecovery: vi.fn(() => staleRecoveryLease)
    }
    const replacementLease = {
      commit: vi.fn(),
      rollback: vi.fn(),
      transferToRecovery: vi.fn(() => replacementRecoveryLease)
    }
    attachForReconnectMock.mockImplementation(async () => {
      const ownerGeneration = openConsumerSessionMock.mock.calls.length
      if (ownerGeneration === 3) {
        queueMicrotask(() => {
          const complete = onNotificationByMethodMock.mock.calls.findLast(
            ([method]) => method === 'pty.recoveryComplete'
          )?.[1] as ((params: Record<string, unknown>) => void) | undefined
          complete?.({
            id: 'pty-1',
            clientGeneration: 3,
            ownerGeneration: 3,
            ptyIncarnation: 'incarnation-1',
            deliveryToken: 'replacement-token',
            checkpointSourceEndSu: 4,
            recoveryEndSu: 4
          })
        })
      }
      return {
        incarnationId: 'incarnation-1',
        sourceRecovery: {
          status: 'pending',
          clientGeneration: ownerGeneration,
          ownerGeneration,
          ptyIncarnation: 'incarnation-1',
          deliveryToken: ownerGeneration === 2 ? 'stale-token' : 'replacement-token',
          checkpointSourceEndSu: 4,
          recoveryEndSu: 4
        },
        sourceActivationLease: ownerGeneration === 2 ? staleLease : replacementLease
      }
    })

    const staleReconnect = session.reconnect(deps.mockConn)
    await vi.waitFor(() => expect(attachForReconnectMock).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    const replacementReconnect = session.reconnect(deps.mockConn)
    await Promise.all([staleReconnect, replacementReconnect])

    const recoveryRequests = attachForReconnectMock.mock.calls.map((call) => call[2])
    expect(recoveryRequests).toHaveLength(2)
    expect(recoveryRequests[1]).toMatchObject({
      status: 'checkpoint',
      deliveryToken: 'old-token',
      acceptedSourceEndSu: 4
    })
    expect(muxRequestMock.mock.calls.filter(([method]) => method === 'pty.cancelDelivery')).toEqual(
      []
    )
    expect(deps.mockStore.markSshRemotePtyLease).toHaveBeenCalledTimes(1)
    expect(deps.mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(targetId, 'pty-1', 'attached')
    expect(setPtyOwnership).toHaveBeenCalledTimes(1)
    expect(staleLease.transferToRecovery).toHaveBeenCalledOnce()
    expect(staleLease.commit).not.toHaveBeenCalled()
    expect(staleLease.rollback).not.toHaveBeenCalled()
    expect(staleRecoveryLease.commit).not.toHaveBeenCalled()
    expect(staleRecoveryLease.retire).toHaveBeenCalledOnce()
    expect(replacementLease.transferToRecovery).toHaveBeenCalledOnce()
    expect(replacementLease.commit).not.toHaveBeenCalled()
    expect(replacementLease.rollback).not.toHaveBeenCalled()
    expect(replacementRecoveryLease.commit).toHaveBeenCalledOnce()
    expect(replacementRecoveryLease.retire).not.toHaveBeenCalled()
    expect(clearProviderPtyState).not.toHaveBeenCalled()
    expect(clearPtyOwnershipForConnection).not.toHaveBeenCalled()
    expect(deletePtyOwnership).not.toHaveBeenCalled()
    expect(deps.mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())
    expect(muxDisposeMock).not.toHaveBeenCalledWith('shutdown')
    expect(session.getState()).toBe('ready')
  })
})
