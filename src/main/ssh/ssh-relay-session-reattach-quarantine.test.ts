import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type * as NodeCrypto from 'node:crypto'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

type MockMuxInstance = {
  requestHandlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>>
}

const { acceptOutputExitMock, muxRequestMock, openConsumerSessionMock, muxInstancesRaw } =
  vi.hoisted(() => ({
    acceptOutputExitMock: vi.fn().mockResolvedValue(undefined),
    muxRequestMock: vi.fn(),
    openConsumerSessionMock: vi.fn(
      async (
        _mux: unknown,
        options: { clientInstanceId: string; outputFlowControl?: unknown }
      ) => ({
        clientInstanceId: options.clientInstanceId,
        clientGeneration: 1,
        ownerGeneration: 1,
        ownerLease: 'test-owner-lease'
      })
    ),
    muxInstancesRaw: [] as unknown[]
  }))
const muxInstances = muxInstancesRaw as MockMuxInstance[]

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: openConsumerSessionMock
}))
vi.mock('../ipc/ssh-pty-output-intake-registry', () => ({
  acceptSshPtyOutputData: vi.fn().mockResolvedValue(undefined),
  acceptSshPtyOutputExit: acceptOutputExitMock,
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
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>()
  return { ...actual, randomUUID: vi.fn() }
})
vi.mock('./ssh-remote-orca-cli', () => ({
  runRemoteOrcaCli: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
}))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    requestHandlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>()
    notify = vi.fn()
    notifyWithSettlement = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onNotificationByMethod = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn(
      (method: string, handler: (params: Record<string, unknown>) => Promise<unknown>) => {
        this.requestHandlers.set(method, handler)
        return () => this.requestHandlers.delete(method)
      }
    )
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)

    constructor() {
      muxInstancesRaw.push(this)
    }
  }
}))
vi.mock('../agent-hooks/remote-managed-hook-installers', () => ({
  installRemoteManagedAgentHooks: vi.fn()
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: (error: unknown) => String(error).includes('not found'),
  isSshPtyIdentityMismatchError: (error: unknown) => String(error).includes('identity mismatch'),
  SshPtyProvider: class MockSshPtyProvider {
    onData = vi.fn().mockReturnValue(() => {})
    onReplay = vi.fn().mockReturnValue(() => {})
    onExit = vi.fn().mockReturnValue(() => {})
    attach = vi.fn().mockResolvedValue(undefined)
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
  getSshPtyProvider: vi.fn(),
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

const { getSshPtyProvider, getPtyIdsForConnection, deletePtyOwnership, clearProviderPtyState } =
  await import('../ipc/pty')

const APP_PTY_ID = 'ssh:target-1@@pty-live'
const INCARNATION_LEAF_ID = '11111111-1111-4111-8111-111111111111'

function detachedLease() {
  return {
    targetId: 'target-1',
    ptyId: 'pty-live',
    state: 'detached' as const,
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: INCARNATION_LEAF_ID,
    createdAt: 1,
    updatedAt: 1
  }
}

describe('SshRelaySession reattach quarantine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxInstances.splice(0)
    delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    vi.mocked(randomUUID).mockReset()
    vi.mocked(randomUUID).mockReturnValue('00000000-0000-4000-8000-000000000001')
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  it('quarantines an incomplete lease without a unique durable pane', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const attachForReconnect = vi.fn()
    vi.mocked(getSshPtyProvider).mockReturnValue({ attachForReconnect } as never)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      { ...detachedLease(), leafId: undefined }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)
    vi.mocked(mockStore.resolveExistingSshPtyBinding).mockReturnValue(null)
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(attachForReconnect).not.toHaveBeenCalled()
    expect(mockStore.quarantineSshRemotePtyLeasesAsync).toHaveBeenCalledWith('target-1', [
      'pty-live'
    ])
    expect(deletePtyOwnership).toHaveBeenCalledWith(APP_PTY_ID)
  })

  it('batches every refused pane into one quarantine write and clears provider state', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const attachForReconnect = vi.fn()
    vi.mocked(getSshPtyProvider).mockReturnValue({ attachForReconnect } as never)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      { ...detachedLease(), ptyId: 'pty-a' },
      { ...detachedLease(), ptyId: 'pty-b', tabId: 'tab-2' },
      { ...detachedLease(), ptyId: 'pty-c', tabId: 'tab-3' }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)
    vi.mocked(mockStore.resolveExistingSshPtyBinding).mockReturnValue(null)
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    // Why: persist every refusal in one awaited durable batch.
    expect(mockStore.quarantineSshRemotePtyLeasesAsync).toHaveBeenCalledTimes(1)
    expect(mockStore.quarantineSshRemotePtyLeasesAsync).toHaveBeenCalledWith('target-1', [
      'pty-a',
      'pty-b',
      'pty-c'
    ])
    for (const ptyId of ['pty-a', 'pty-b', 'pty-c']) {
      expect(deletePtyOwnership).toHaveBeenCalledWith(`ssh:target-1@@${ptyId}`)
      expect(clearProviderPtyState).toHaveBeenCalledWith(`ssh:target-1@@${ptyId}`)
    }
  })

  it('does not let an older final identity duplicate block its active winner', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const attachForReconnect = vi.fn().mockResolvedValue({ incarnationId: 'incarnation-live' })
    vi.mocked(getSshPtyProvider).mockReturnValue({ attachForReconnect } as never)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      { ...detachedLease(), state: 'expired', createdAt: 1, updatedAt: 1 },
      { ...detachedLease(), createdAt: 2, updatedAt: 2 }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await session.establish(mockConn)

    expect(attachForReconnect).toHaveBeenCalledOnce()
    expect(mockStore.quarantineSshRemotePtyLeasesAsync).not.toHaveBeenCalled()
  })

  it('retains provider state when durable quarantine fails', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      { ...detachedLease(), leafId: undefined }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)
    vi.mocked(mockStore.resolveExistingSshPtyBinding).mockReturnValue(null)
    vi.mocked(mockStore.quarantineSshRemotePtyLeasesAsync).mockRejectedValue(
      new Error('disk unavailable')
    )
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await expect(session.establish(mockConn)).rejects.toThrow('disk unavailable')

    expect(clearProviderPtyState).not.toHaveBeenCalled()
    expect(deletePtyOwnership).not.toHaveBeenCalled()
  })

  it('fails establishment when a refused attach cannot prove source cancellation', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const sourceActivationLease = {
      commit: vi.fn(),
      rollback: vi.fn().mockResolvedValue(false)
    }
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue({
        incarnationId: 'incarnation-raced',
        sourceActivationLease
      })
    } as never)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([detachedLease()] as ReturnType<
      typeof mockStore.getSshRemotePtyLeases
    >)
    vi.mocked(mockStore.persistPtyBinding).mockReturnValue('refused')
    const session = new SshRelaySession('target-1', getMainWindow, mockStore, mockPortForward)

    await expect(session.establish(mockConn)).rejects.toMatchObject({
      code: 'ssh_source_recovery_cancellation_failed'
    })

    expect(sourceActivationLease.rollback).toHaveBeenCalledOnce()
    expect(mockStore.quarantineSshRemotePtyLeasesAsync).not.toHaveBeenCalled()
    expect(session.getState()).toBe('idle')
  })
})
