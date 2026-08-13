import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatPtyExitedError } from '../../shared/ssh-pty-failure-tokens'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { acceptOutputExitMock, muxRequestMock } = vi.hoisted(() => ({
  acceptOutputExitMock: vi.fn().mockResolvedValue(undefined),
  muxRequestMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-pty-consumer-session', () => ({
  openSshPtyConsumerSession: vi.fn(
    async (_mux: unknown, options: { clientInstanceId: string }) => ({
      clientInstanceId: options.clientInstanceId,
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'test-owner-lease'
    })
  )
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
  installRemoteManagedAgentHooks: vi.fn().mockResolvedValue([])
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
  resolvePaneShellTabId: vi.fn(() => undefined),
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
  clearProviderPtyState,
  deletePtyOwnership
} = await import('../ipc/pty')

const TARGET_ID = 'target-1'
const RELAY_PTY_ID = 'pty-live'
const APP_PTY_ID = 'ssh:target-1@@pty-live'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PROVIDER_GENERATION = 17

// The relay's own not-found wording; `isSshPtyNotFoundError` matches it and nothing narrows it
// further, so it arrives carrying no evidence about whether the shell is alive.
const UNPROVEN_NOT_FOUND = `PTY "${RELAY_PTY_ID}" not found`

function detachedLease() {
  return {
    targetId: TARGET_ID,
    ptyId: RELAY_PTY_ID,
    state: 'detached' as const,
    worktreeId: 'worktree-1',
    tabId: 'tab-1',
    leafId: LEAF_ID,
    incarnationId: 'inc-proven-exit'
  }
}

/**
 * STA-3077 / design E-0: a reattach that ends in a bare not-found tells us the relay cannot hand
 * this id back — never that the process died. Synthesizing `pty:exit { code: -1 }` from it is a
 * fabricated death certificate: the renderer treats it as a real exit and the surviving remote
 * shell (and any agent inside it) is written off. Only an exit the relay actually observed may
 * report an exit; everything else routes into the non-destructive detached branch.
 */
describe('SshRelaySession reattach failures never fabricate an exit', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    acceptOutputExitMock.mockResolvedValue(undefined)
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Drives the real connect-path reattach loop, so the failure reaches the handler as production does. */
  async function reattachFailsWith(message: string): Promise<{
    deps: ReturnType<typeof createMockDeps>
    attachForReconnect: ReturnType<typeof vi.fn>
  }> {
    const deps = createMockDeps()
    const attachForReconnect = vi.fn().mockRejectedValue(new Error(message))
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect,
      shutdown: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(deps.mockStore.getSshRemotePtyLeases).mockReturnValue([detachedLease()] as ReturnType<
      typeof deps.mockStore.getSshRemotePtyLeases
    >)
    const session = new SshRelaySession(
      TARGET_ID,
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )

    await session.establish(deps.mockConn)
    // Precondition, not a claim: if the reattach never ran, every "did not destroy" clause below
    // would pass for the wrong reason.
    expect(attachForReconnect).toHaveBeenCalled()

    return { deps, attachForReconnect }
  }

  function warnings(): string[] {
    return warn.mock.calls.map((call) => String(call[0]))
  }

  it('reaches the failure handler through the real reattach path', async () => {
    // Producer pin: without this the remaining clauses could pass on a path production never takes.
    const { attachForReconnect } = await reattachFailsWith(UNPROVEN_NOT_FOUND)

    expect(attachForReconnect.mock.calls[0]?.[0]).toBe(RELAY_PTY_ID)
  })

  it('sends no synthetic pty:exit to the pane on an unproven not-found', async () => {
    const { deps } = await reattachFailsWith(UNPROVEN_NOT_FOUND)

    expect(deps.mockWindow.webContents.send).not.toHaveBeenCalledWith('pty:exit', expect.anything())
  })

  it('keeps pty ownership on an unproven not-found', async () => {
    await reattachFailsWith(UNPROVEN_NOT_FOUND)

    expect(deletePtyOwnership).not.toHaveBeenCalledWith(APP_PTY_ID)
  })

  it('keeps provider pty state on an unproven not-found', async () => {
    await reattachFailsWith(UNPROVEN_NOT_FOUND)

    expect(clearProviderPtyState).not.toHaveBeenCalledWith(APP_PTY_ID)
  })

  it('leaves the lease terminable instead of expiring it on an unproven not-found', async () => {
    const { deps } = await reattachFailsWith(UNPROVEN_NOT_FOUND)

    expect(deps.mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
      TARGET_ID,
      RELAY_PTY_ID,
      'expired'
    )
  })

  // The counterpart. An exit the relay watched settles it, so the record is retired rather than
  // re-attached on every future reconnect for the life of the install. `terminated`, not `expired`:
  // expiry is the state the recovery grant reads, and retiring a record must not also authorise a
  // replacement.
  it('retires the lease on an exit the relay proved', async () => {
    const { deps } = await reattachFailsWith(
      formatPtyExitedError(RELAY_PTY_ID, 0, 'inc-proven-exit')
    )

    expect(deps.mockStore.markSshRemotePtyLeasesTerminatedAsync).toHaveBeenCalledWith(TARGET_ID, [
      RELAY_PTY_ID
    ])
  })

  it('persists a reconnect batch of proven exits in one async write', async () => {
    const deps = createMockDeps()
    const secondPtyId = 'pty-second'
    const secondIncarnationId = 'inc-proven-second-exit'
    const attachForReconnect = vi.fn().mockImplementation((ptyId: string) => {
      const incarnationId = ptyId === RELAY_PTY_ID ? 'inc-proven-exit' : secondIncarnationId
      return Promise.reject(new Error(formatPtyExitedError(ptyId, 0, incarnationId)))
    })
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect,
      shutdown: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(deps.mockStore.getSshRemotePtyLeases).mockReturnValue([
      detachedLease(),
      {
        ...detachedLease(),
        ptyId: secondPtyId,
        leafId: '22222222-2222-4222-8222-222222222222',
        incarnationId: secondIncarnationId
      }
    ] as ReturnType<typeof deps.mockStore.getSshRemotePtyLeases>)
    const session = new SshRelaySession(
      TARGET_ID,
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )

    await session.establish(deps.mockConn)

    expect(deps.mockStore.markSshRemotePtyLeasesTerminatedAsync).toHaveBeenCalledOnce()
    expect(deps.mockStore.markSshRemotePtyLeasesTerminatedAsync).toHaveBeenCalledWith(TARGET_ID, [
      RELAY_PTY_ID,
      secondPtyId
    ])
    expect(deps.mockStore.markSshRemotePtyLease).not.toHaveBeenCalled()
  })

  it('does not retire the lease for proof naming another PTY', async () => {
    const { deps } = await reattachFailsWith(
      formatPtyExitedError('pty-some-other-shell', 0, 'inc-proven-exit')
    )

    expect(deps.mockStore.markSshRemotePtyLeasesTerminatedAsync).not.toHaveBeenCalled()
  })

  it('does not retire the lease for proof naming another incarnation', async () => {
    const { deps } = await reattachFailsWith(
      formatPtyExitedError(RELAY_PTY_ID, 0, 'inc-some-other-shell')
    )

    expect(deps.mockStore.markSshRemotePtyLeasesTerminatedAsync).not.toHaveBeenCalled()
  })

  it('does not retire the lease when the failure proves nothing', async () => {
    const { deps } = await reattachFailsWith(UNPROVEN_NOT_FOUND)

    expect(deps.mockStore.markSshRemotePtyLeasesTerminatedAsync).not.toHaveBeenCalled()
  })

  it('routes an unproven not-found into the non-destructive detached branch', async () => {
    // That branch announces itself with the "leaving detached" warning; the destructive one says
    // "dropping stale". The log is how the two are told apart from outside the session.
    await reattachFailsWith(UNPROVEN_NOT_FOUND)

    expect(warnings().some((line) => line.includes(RELAY_PTY_ID) && /detached/i.test(line))).toBe(
      true
    )
  })

  it('does not take the drop-stale branch on an unproven not-found', async () => {
    await reattachFailsWith(UNPROVEN_NOT_FOUND)

    expect(warnings().some((line) => /Dropping stale PTY/i.test(line))).toBe(false)
  })

  it('still reports an exit the relay actually observed', async () => {
    // Contrast: the only evidence that authorizes a death claim is an exit the relay saw on a live
    // stream. Removing the fabricated one must not mute this one.
    const deps = createMockDeps()
    vi.mocked(getSshPtyProvider).mockReturnValue({
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(deps.mockStore.getSshRemotePtyLeases).mockReturnValue(
      [] as ReturnType<typeof deps.mockStore.getSshRemotePtyLeases>
    )
    const session = new SshRelaySession(
      TARGET_ID,
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )
    await session.establish(deps.mockConn)
    const provider = vi.mocked(registerSshPtyProvider).mock.calls[0]?.[1] as unknown as {
      onExit: ReturnType<typeof vi.fn>
    }
    const onExit = provider.onExit.mock.calls[0]?.[0] as (payload: unknown) => void

    onExit({
      id: APP_PTY_ID,
      code: 3,
      incarnationId: 'incarnation-1',
      providerGeneration: PROVIDER_GENERATION,
      ptyIncarnation: 'incarnation-1'
    })

    await vi.waitFor(() =>
      expect(acceptOutputExitMock).toHaveBeenCalledWith({
        id: APP_PTY_ID,
        code: 3,
        providerGeneration: PROVIDER_GENERATION,
        ptyIncarnation: 'incarnation-1'
      })
    )
    expect(deps.mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      TARGET_ID,
      RELAY_PTY_ID,
      'terminated'
    )
    expect(deletePtyOwnership).toHaveBeenCalledWith(APP_PTY_ID)
  })
})
