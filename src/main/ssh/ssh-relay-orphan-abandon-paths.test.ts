import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'
import { isProvenProcessExit } from '../../shared/terminal-exit-cause'

const { muxRequestMock, openConsumerSessionMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  openConsumerSessionMock: vi.fn(async (_mux: unknown, options: { clientInstanceId: string }) => ({
    clientInstanceId: options.clientInstanceId,
    clientGeneration: 1,
    ownerGeneration: 1,
    ownerLease: 'test-owner-lease'
  }))
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
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('./ssh-remote-orca-cli', () => ({
  runRemoteOrcaCli: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' })
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
  installRemoteManagedAgentHooks: vi.fn()
}))
vi.mock('../providers/ssh-pty-provider', () => ({
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

const { getSshPtyProvider, getPtyIdsForConnection, clearProviderPtyState, deletePtyOwnership } =
  await import('../ipc/pty')

const APP_PTY_ID = 'ssh:target-1@@pty-live'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function detachedLease() {
  return {
    targetId: 'target-1',
    ptyId: 'pty-live',
    state: 'detached' as const,
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: LEAF_ID
  }
}

/**
 * STA-3376: every reattach failure walks away from a remote PTY that may still be running a user's
 * work. Orca's rule is that unprovable liveness never authorizes destroying a session, so these
 * assert the opposite of a leak test: the shell must survive, and the lease must stay in a state
 * the user-facing terminate action can still reach.
 */
describe('SshRelaySession abandoned remote PTYs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  async function establishWithFailingReattach(error: Error): Promise<{
    deps: ReturnType<typeof createMockDeps>
    shutdown: ReturnType<typeof vi.fn>
    attachForReconnect: ReturnType<typeof vi.fn>
    runtime: { onPtyExit: ReturnType<typeof vi.fn>; registerPty: ReturnType<typeof vi.fn> }
  }> {
    const deps = createMockDeps()
    const shutdown = vi.fn().mockResolvedValue(undefined)
    const attachForReconnect = vi.fn().mockRejectedValue(error)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect,
      shutdown,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(deps.mockStore.getSshRemotePtyLeases).mockReturnValue([detachedLease()] as ReturnType<
      typeof deps.mockStore.getSshRemotePtyLeases
    >)
    const runtime = { onPtyExit: vi.fn(), registerPty: vi.fn() }
    const session = new SshRelaySession(
      'target-1',
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward,
      runtime as never
    )

    await session.establish(deps.mockConn)

    return { deps, shutdown, attachForReconnect, runtime }
  }

  it('leaves a live shell running and reachable when reattach attempts are exhausted', async () => {
    // A transport stall proves nothing about the remote shell; the user's long-running process
    // may be untouched, so the lease must stay terminable rather than be tombstoned as expired.
    const { deps, shutdown, attachForReconnect, runtime } = await establishWithFailingReattach(
      new Error('PTY reattach attempt timed out after 15000ms')
    )

    expect(attachForReconnect).toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(deps.mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'target-1',
      'pty-live',
      'expired'
    )
    expect(deletePtyOwnership).not.toHaveBeenCalledWith(APP_PTY_ID)
    expect(deps.mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())
  })

  it('leaves another pane live shell running when the relay reports an identity mismatch', async () => {
    // The relay answered that a *live* PTY holds this id under a different pane identity. Killing
    // it would destroy an unrelated terminal, so this path may only stop claiming the id.
    const { deps, shutdown, attachForReconnect, runtime } = await establishWithFailingReattach(
      new Error('PTY "pty-live" not found (identity mismatch)')
    )

    expect(attachForReconnect).toHaveBeenCalled()
    expect(shutdown).not.toHaveBeenCalled()
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    expect(deps.mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'target-1',
      'pty-live',
      'expired'
    )
    expect(clearProviderPtyState).not.toHaveBeenCalledWith(APP_PTY_ID)
  })

  it('publishes a disowned-source signal when the relay answers not-found', async () => {
    // A reachable relay answered for this exact id and disowned it. That licenses replacing the
    // pane — respawning leaks the old process rather than killing it — but a restarted relay
    // answers the same way for ids it never minted, so this is not an `exited` verdict
    // (docs/reference/ssh-execution-boundary.md).
    const { deps, shutdown, runtime } = await establishWithFailingReattach(
      new Error('PTY "pty-live" not found')
    )

    expect(shutdown).not.toHaveBeenCalled()
    // The runtime is where a death certificate would land (`hostExitConfirmed`), and this branch
    // holds no evidence to write one from.
    expect(runtime.onPtyExit).not.toHaveBeenCalled()
    // 'expired' records that reattach gave up on the id, not that the shell died; ssh:terminateSessions still reaches it.
    expect(deps.mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      'target-1',
      'pty-live',
      'expired'
    )
    expect(clearProviderPtyState).toHaveBeenCalledWith(APP_PTY_ID)
    expect(deps.mockWindow.webContents.send).toHaveBeenCalledWith('pty:exit', {
      id: APP_PTY_ID,
      code: -1,
      ptySourceDisowned: true
    })
    const exitCall = vi
      .mocked(deps.mockWindow.webContents.send)
      .mock.calls.find(([channel]) => channel === 'pty:exit')
    if (!exitCall) {
      throw new Error('expected a pty:exit publication')
    }
    // The ratchet: the verdict rides its own field, never the code. Swapping -1 for a provable
    // status would make every reader that keys off the code close the tab and drop its leaf↔PTY
    // binding, which is a far wider claim than "this id is gone from this relay".
    expect(isProvenProcessExit((exitCall[1] as { code: number }).code)).toBe(false)
  })

  it('keeps a recovered session attached when reattach succeeds after an earlier drop', async () => {
    const deps = createMockDeps()
    const shutdown = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue({ incarnationId: 'incarnation-1' }),
      shutdown,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(deps.mockStore.getSshRemotePtyLeases).mockReturnValue([detachedLease()] as ReturnType<
      typeof deps.mockStore.getSshRemotePtyLeases
    >)
    const runtime = { onPtySpawned: vi.fn(), registerPty: vi.fn() }
    const session = new SshRelaySession(
      'target-1',
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward,
      runtime as never
    )

    await session.establish(deps.mockConn)

    expect(shutdown).not.toHaveBeenCalled()
    expect(runtime.registerPty).toHaveBeenCalledWith(APP_PTY_ID, 'worktree-1', 'target-1', {
      tabId: 'tab-1',
      leafId: LEAF_ID,
      incarnationId: 'incarnation-1'
    })
    expect(deps.mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      'target-1',
      'pty-live',
      'expired'
    )
  })
})
