import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

type SettledMigration = {
  status: 'settled'
  checkpoint: {
    id: string
    providerGeneration: number
    clientGeneration: number
    ownerGeneration: number
    ptyIncarnation: string
    deliveryToken: string
    acceptedSourceEndSu: number
  }
}

const { attachForReconnectMock, beginMigrationMock, muxRequestMock, openConsumerSessionMock } =
  vi.hoisted(() => ({
    attachForReconnectMock: vi.fn().mockResolvedValue({}),
    beginMigrationMock: vi.fn(() => ({
      byPty: new Map(),
      completion: Promise.resolve()
    })),
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
  beginSshPtyOutputGenerationMigration: beginMigrationMock,
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

vi.mock('../providers/ssh-pty-provider', () => ({
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
    attachForReconnect = attachForReconnectMock
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

const { getPtyIdsForConnection, getSshPtyProvider, registerSshPtyProvider } =
  await import('../ipc/pty')
const { getSshPtyAcceptedSourceCheckpoints } = await import('../ipc/ssh-pty-output-intake-registry')

function pendingMigration() {
  let resolve!: (result: SettledMigration) => void
  const result = new Promise<SettledMigration>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { result, resolve }
}

function settledMigration(appPtyId: string, acceptedSourceEndSu: number): SettledMigration {
  return {
    status: 'settled',
    checkpoint: {
      id: appPtyId,
      providerGeneration: 23,
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-1',
      deliveryToken: 'old-token',
      acceptedSourceEndSu
    }
  }
}

describe('SshRelaySession model migration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReturnValue([])
    openConsumerSessionMock.mockImplementation(async (_mux, options) => ({
      state: {
        mode: 'negotiated',
        clientInstanceId: options.clientInstanceId,
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'owner-lease-1',
        ...(options.outputFlowControl
          ? {
              outputFlowControl: {
                version: 1,
                windowSu: options.outputFlowControl.requestedWindowSu
              }
            }
          : {})
      },
      resumed: options.resume !== undefined
    }))
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
  })

  it('keeps overlapping reconnects behind the old-generation model migration', async () => {
    const targetId = 'migration-fence'
    const appPtyId = `ssh:${targetId}@@pty-1`
    const migration = pendingMigration()
    beginMigrationMock.mockReturnValueOnce({
      byPty: new Map([[appPtyId, migration.result]]),
      completion: migration.result.then(() => {})
    })
    vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReturnValue([
      {
        id: appPtyId,
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
    vi.mocked(getPtyIdsForConnection).mockReturnValue([appPtyId])
    vi.mocked(getSshPtyProvider).mockImplementation(
      () => vi.mocked(registerSshPtyProvider).mock.calls.at(-1)?.[1]
    )
    attachForReconnectMock.mockResolvedValue({
      incarnationId: 'incarnation-1',
      sourceRecovery: { status: 'restoreRequired', reason: 'relayRestoreRequired' }
    })

    const firstReconnect = session.reconnect(deps.mockConn)
    await vi.waitFor(() => expect(registerSshPtyProvider).toHaveBeenCalledTimes(2))
    const secondReconnect = session.reconnect(deps.mockConn)
    await vi.waitFor(() => expect(beginMigrationMock).toHaveBeenCalledTimes(2))
    expect(attachForReconnectMock).not.toHaveBeenCalled()

    migration.resolve(settledMigration(appPtyId, 8))
    await Promise.all([firstReconnect, secondReconnect])

    expect(attachForReconnectMock).toHaveBeenCalledWith(
      'pty-1',
      Object.freeze({
        status: 'checkpoint',
        clientGeneration: 1,
        ownerGeneration: 1,
        ptyIncarnation: 'incarnation-1',
        deliveryToken: 'old-token',
        acceptedSourceEndSu: 8
      })
    )
  })

  it('waits for a voided-checkpoint migration before requesting restore', async () => {
    const targetId = 'migration-stale-owner'
    const appPtyId = `ssh:${targetId}@@pty-1`
    const migration = pendingMigration()
    beginMigrationMock.mockReturnValueOnce({
      byPty: new Map([[appPtyId, migration.result]]),
      completion: migration.result.then(() => {})
    })
    vi.mocked(getSshPtyAcceptedSourceCheckpoints).mockReturnValue([
      settledMigration(appPtyId, 4).checkpoint
    ])
    const deps = createMockDeps()
    const session = new SshRelaySession(
      targetId,
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )
    await session.establish(deps.mockConn)
    vi.mocked(getPtyIdsForConnection).mockReturnValue([appPtyId])
    vi.mocked(getSshPtyProvider).mockImplementation(
      () => vi.mocked(registerSshPtyProvider).mock.calls.at(-1)?.[1]
    )
    openConsumerSessionMock.mockImplementationOnce(async (_mux, options) => ({
      state: {
        mode: 'negotiated',
        clientInstanceId: options.clientInstanceId,
        clientGeneration: 2,
        ownerGeneration: 2,
        ownerLease: 'fresh-owner-lease',
        outputFlowControl: { version: 1, windowSu: 256 * 1024 }
      },
      resumed: false
    }))
    attachForReconnectMock.mockResolvedValue({
      incarnationId: 'incarnation-1',
      sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' }
    })

    const reconnect = session.reconnect(deps.mockConn)
    await vi.waitFor(() => expect(openConsumerSessionMock).toHaveBeenCalledTimes(2))
    expect(attachForReconnectMock).not.toHaveBeenCalled()

    migration.resolve(settledMigration(appPtyId, 8))
    await reconnect

    expect(attachForReconnectMock).toHaveBeenCalledWith(
      'pty-1',
      Object.freeze({ status: 'checkpointUnavailable' })
    )
  })
})
