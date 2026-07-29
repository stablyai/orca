import { beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type * as NodeCrypto from 'node:crypto'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

type MockMuxInstance = {
  requestHandlers: Map<string, (params: Record<string, unknown>) => Promise<unknown>>
}

const { muxRequestMock, muxInstancesRaw } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  muxInstancesRaw: [] as unknown[]
}))
const muxInstances = muxInstancesRaw as MockMuxInstance[]

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
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
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
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

const {
  registerSshPtyProvider,
  getSshPtyProvider,
  getPtyIdsForConnection,
  setPtyOwnership,
  restorePtyIncarnation
} = await import('../ipc/pty')

const APP_PTY_ID = 'ssh:target-1@@pty-live'
const INCARNATION_LEAF_ID = '11111111-1111-4111-8111-111111111111'

function detachedLease() {
  return {
    targetId: 'target-1',
    ptyId: 'pty-live',
    state: 'detached' as const,
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: INCARNATION_LEAF_ID
  }
}

function emitExitDuringAttach(payload: { id: string; code: number; incarnationId?: string }): void {
  const registeredProvider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
    onExit: ReturnType<typeof vi.fn>
  }
  const exitHandler = registeredProvider.onExit.mock.calls[0]?.[0] as
    | ((exit: typeof payload) => void)
    | undefined
  queueMicrotask(() => exitHandler?.(payload))
}

describe('SshRelaySession reconnect incarnation ordering', () => {
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

  it('keeps the winning reconnect incarnation when a stale health check resolves last', async () => {
    const initialIncarnation = '00000000-0000-4000-8000-000000000001'
    const winningIncarnation = '00000000-0000-4000-8000-000000000002'
    const staleIncarnation = '00000000-0000-4000-8000-000000000003'
    let resolveStaleHealthCheck!: (value: unknown) => void
    const staleHealthCheck = new Promise((resolve) => {
      resolveStaleHealthCheck = resolve
    })
    let resolveHomeCalls = 0
    muxRequestMock.mockImplementation((method: string) => {
      if (method !== 'session.resolveHome') {
        return Promise.resolve([])
      }
      resolveHomeCalls += 1
      return resolveHomeCalls === 2 ? staleHealthCheck : Promise.resolve('/')
    })
    vi.mocked(randomUUID)
      .mockReturnValueOnce(initialIncarnation)
      .mockReturnValueOnce(winningIncarnation)
      .mockReturnValue(staleIncarnation)
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const runtime = {
      registerOrchestrationCompatibilitySshAttachment: vi.fn(
        (_targetId: string, connectionIncarnation: string) => ({
          attachmentId: `attachment-${connectionIncarnation}`,
          connectionIncarnation
        })
      ),
      releaseOrchestrationCompatibilitySshAttachment: vi.fn()
    }
    const session = new SshRelaySession(
      'target-1',
      getMainWindow,
      mockStore,
      mockPortForward,
      runtime as never
    )
    await session.establish(mockConn)

    const staleReconnect = session.reconnect(mockConn)
    await vi.waitFor(() => expect(resolveHomeCalls).toBe(2))
    await session.reconnect(mockConn)
    expect(session.getState()).toBe('ready')

    resolveStaleHealthCheck('/')
    await staleReconnect

    const winningCliHandler = muxInstances[2]?.requestHandlers.get('orca.cli')
    expect(winningCliHandler).toBeDefined()
    await winningCliHandler?.({ argv: ['status'], cwd: '/', env: {} })

    expect(runtime.registerOrchestrationCompatibilitySshAttachment).toHaveBeenCalledWith(
      'target-1',
      winningIncarnation
    )
    expect(randomUUID).toHaveBeenCalledTimes(2)
  })

  it('restores and persists exact incarnation proof from reconnect attach', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const incarnationId = 'incarnation-reconnect'
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue({ incarnationId }),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([detachedLease()] as ReturnType<
      typeof mockStore.getSshRemotePtyLeases
    >)
    const runtime = { onPtySpawned: vi.fn(), registerPty: vi.fn() }
    const session = new SshRelaySession(
      'target-1',
      getMainWindow,
      mockStore,
      mockPortForward,
      runtime as never
    )

    await session.establish(mockConn)

    expect(restorePtyIncarnation).toHaveBeenCalledWith(APP_PTY_ID, incarnationId)
    expect(runtime.registerPty).toHaveBeenCalledWith(APP_PTY_ID, 'worktree-1', 'target-1', {
      tabId: 'tab-1',
      leafId: INCARNATION_LEAF_ID,
      incarnationId
    })
    expect(runtime.onPtySpawned).not.toHaveBeenCalled()
    expect(mockStore.persistPtyBinding).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      leafId: INCARNATION_LEAF_ID,
      ptyId: APP_PTY_ID,
      incarnationId
    })
    expect(vi.mocked(mockStore.persistPtyBinding).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(mockStore.markSshRemotePtyLease).mock.invocationCallOrder[0]!
    )
  })

  it('does not restore a PTY whose matching exit shares the attach reply batch', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const incarnationId = 'incarnation-exited-during-attach'
    const runtime = {
      acceptPtyIncarnationForExit: vi.fn(),
      onPtyExit: vi.fn(),
      onPtySpawned: vi.fn(),
      registerPty: vi.fn()
    }
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockImplementation(async () => {
        emitExitDuringAttach({ id: APP_PTY_ID, code: 0, incarnationId })
        emitExitDuringAttach({ id: APP_PTY_ID, code: 0, incarnationId: 'incarnation-stale' })
        return { incarnationId, replay: 'dead-output' }
      }),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([detachedLease()] as ReturnType<
      typeof mockStore.getSshRemotePtyLeases
    >)
    const session = new SshRelaySession(
      'target-1',
      getMainWindow,
      mockStore,
      mockPortForward,
      runtime as never
    )

    await session.establish(mockConn)

    expect(runtime.onPtyExit).toHaveBeenCalledWith(APP_PTY_ID, 0, incarnationId)
    expect(runtime.acceptPtyIncarnationForExit).toHaveBeenCalledWith(APP_PTY_ID, incarnationId)
    expect(runtime.registerPty).not.toHaveBeenCalled()
    expect(restorePtyIncarnation).toHaveBeenCalledWith(APP_PTY_ID, incarnationId)
    expect(setPtyOwnership).not.toHaveBeenCalled()
    expect(mockStore.persistPtyBinding).not.toHaveBeenCalled()
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      'target-1',
      'pty-live',
      'terminated'
    )
    expect(
      vi
        .mocked(mockWindow.webContents.send)
        .mock.calls.some(([channel]) => channel === 'pty:replay')
    ).toBe(false)
  })

  it('ignores an older incarnation exit while reconnecting a reused PTY id', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow, mockWindow } = createMockDeps()
    const currentIncarnationId = 'incarnation-current'
    const runtime = {
      acceptPtyIncarnationForExit: vi.fn(),
      onPtyExit: vi.fn(),
      onPtySpawned: vi.fn(),
      registerPty: vi.fn()
    }
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockImplementation(async () => {
        emitExitDuringAttach({
          id: APP_PTY_ID,
          code: 0,
          incarnationId: 'incarnation-old'
        })
        return { incarnationId: currentIncarnationId, replay: 'live-output' }
      }),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([detachedLease()] as ReturnType<
      typeof mockStore.getSshRemotePtyLeases
    >)
    const session = new SshRelaySession(
      'target-1',
      getMainWindow,
      mockStore,
      mockPortForward,
      runtime as never
    )

    await session.establish(mockConn)

    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(runtime.acceptPtyIncarnationForExit).not.toHaveBeenCalled()
    expect(runtime.registerPty).toHaveBeenCalledWith(APP_PTY_ID, 'worktree-1', 'target-1', {
      tabId: 'tab-1',
      leafId: INCARNATION_LEAF_ID,
      incarnationId: currentIncarnationId
    })
    expect(setPtyOwnership).toHaveBeenCalledWith(APP_PTY_ID, 'target-1')
    expect(mockStore.persistPtyBinding).toHaveBeenCalledWith(
      expect.objectContaining({ ptyId: APP_PTY_ID, incarnationId: currentIncarnationId })
    )
    expect(mockWindow.webContents.send).toHaveBeenCalledWith('pty:replay', {
      id: APP_PTY_ID,
      data: 'live-output'
    })
  })

  it('keeps the attached PTY when incarnation backfill persistence fails', async () => {
    const { mockConn, mockStore, mockPortForward, getMainWindow } = createMockDeps()
    const incarnationId = 'incarnation-reconnect'
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue({ incarnationId }),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([detachedLease()] as ReturnType<
      typeof mockStore.getSshRemotePtyLeases
    >)
    vi.mocked(mockStore.persistPtyBinding).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const runtime = { onPtySpawned: vi.fn(), registerPty: vi.fn() }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const session = new SshRelaySession(
      'target-1',
      getMainWindow,
      mockStore,
      mockPortForward,
      runtime as never
    )

    await expect(session.establish(mockConn)).resolves.toBeUndefined()

    expect(runtime.registerPty).toHaveBeenCalledWith(APP_PTY_ID, 'worktree-1', 'target-1', {
      tabId: 'tab-1',
      leafId: INCARNATION_LEAF_ID,
      incarnationId
    })
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith('target-1', 'pty-live', 'attached')
    expect(consoleError).toHaveBeenCalledWith(
      '[ssh-relay-session] Failed to persist reconnect incarnation:',
      expect.any(Error)
    )
    consoleError.mockRestore()
  })
})
