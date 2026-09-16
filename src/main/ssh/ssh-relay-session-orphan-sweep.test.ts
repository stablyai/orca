// #9819 end to end on the client: the sweep runs only after reattach, only under a negotiated
// session-owner grant, and only against PTYs this relay itself attributes to this client.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock, openConsumerSessionMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  openConsumerSessionMock: vi.fn(async (_mux: unknown, options: { clientInstanceId: string }) => ({
    state: {
      mode: 'negotiated' as const,
      clientInstanceId: options.clientInstanceId,
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'test-owner-lease'
    },
    resumed: false
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
  applySshPtySourceCancellationProof: vi.fn(() => true),
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

const { getSshPtyProvider, getPtyIdsForConnection } = await import('../ipc/pty')

const OUR_CLIENT = 'client-instance-1'

// One target per test. `claimSshPtyConsumerRecovery` keeps a module-level map keyed on target and
// mints a FRESH clientInstanceId whenever it is asked for a target it already holds a live entry
// for — so a second `establish` on a shared target silently stops matching the host attestation and
// every assertion after the first passes for the wrong reason.
let targetSeq = 0
function nextTarget(): string {
  targetSeq += 1
  return `target-${targetSeq}`
}

const OBSERVATION = { authorityGeneration: 'gen-1', observationEpoch: 1, capturedAgeMs: 0 }

function hostEntry(
  target: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: `ssh:${target}@@pty-orphan`,
    incarnationId: 'inc-orphan',
    cwd: '/home/user',
    title: 'zsh',
    // The relay stamps this from the live consumer grant, so it names THIS client.
    ownerClientInstanceId: OUR_CLIENT,
    hostAgeMs: 120_000,
    paneBound: true,
    // The same listing's host observation: the shell owns the terminal, nothing is running.
    foregroundProcessEvidence: {
      ...OBSERVATION,
      verdict: 'live',
      processName: null,
      shellOwnsEveryTtyProcessGroup: true
    },
    ...overrides
  }
}

describe('SshRelaySession orphaned relay PTY sweep', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  afterEach(() => {
    warn.mockRestore()
  })

  async function establish(
    target: string,
    processes: Record<string, unknown>[],
    leases: { ptyId: string; state: string }[] = []
  ): Promise<{ shutdown: ReturnType<typeof vi.fn>; listProcesses: ReturnType<typeof vi.fn> }> {
    const deps = createMockDeps()
    // Why the recovery row: it pins this session's clientInstanceId, and the comparison is
    // meaningless unless the id it uses is the persisted one.
    vi.mocked(deps.mockStore.getSshPtyConsumerRecovery).mockReturnValue({
      targetId: target,
      clientInstanceId: OUR_CLIENT,
      serverBuildId: 'build-1',
      clientGeneration: 1,
      ownerGeneration: 1,
      ownerLease: 'test-owner-lease'
    } as ReturnType<typeof deps.mockStore.getSshPtyConsumerRecovery>)
    vi.mocked(deps.mockStore.getSshRemotePtyLeases).mockReturnValue(
      leases.map((lease) => ({ targetId: target, ...lease })) as ReturnType<
        typeof deps.mockStore.getSshRemotePtyLeases
      >
    )
    const shutdown = vi.fn().mockResolvedValue(undefined)
    const listProcesses = vi.fn().mockResolvedValue(processes)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      attachForReconnect: vi.fn().mockResolvedValue({}),
      listProcesses,
      shutdown,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)

    const session = new SshRelaySession(
      target,
      deps.getMainWindow,
      deps.mockStore,
      deps.mockPortForward
    )
    await session.establish(deps.mockConn)
    // Both guards exist because every "never stops" case below is trivially satisfiable. The pass
    // has to have run, and it has to have run under the identity the host attests — a session that
    // minted a fresh one compares against nothing and skips everything for the wrong reason.
    expect(listProcesses).toHaveBeenCalledTimes(1)
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('minting a new consumer identity')
    )
    return { shutdown, listProcesses }
  }

  it('stops an attested orphan the client has no lease for', async () => {
    const target = nextTarget()
    const { shutdown } = await establish(target, [hostEntry(target)])

    expect(shutdown).toHaveBeenCalledWith(
      `ssh:${target}@@pty-orphan`,
      expect.objectContaining({ immediate: true, expectedIncarnationId: 'inc-orphan' })
    )
  })

  it('never stops a PTY that still holds a live lease', async () => {
    const target = nextTarget()
    const { shutdown } = await establish(
      target,
      [hostEntry(target, { id: `ssh:${target}@@pty-live`, incarnationId: 'inc-live' })],
      [{ ptyId: 'pty-live', state: 'detached' }]
    )

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('never stops a PTY whose lease this client expired rather than ordered stopped', async () => {
    // What reaches this state in the field: a pane re-leased under a new relay id, a reattach that
    // failed on the transport (dropStalePty), or a pane surface missing from the layout. All three
    // leave the remote process running on purpose.
    const target = nextTarget()
    const { shutdown } = await establish(
      target,
      [hostEntry(target, { id: `ssh:${target}@@pty-gone`, incarnationId: 'inc-gone' })],
      [{ ptyId: 'pty-gone', state: 'expired' }]
    )

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('never stops a pane this relay observes running a foreground process', async () => {
    // agentSessionOwners is empty here — the user typed `claude` themselves — so the only thing
    // between a live agent and a stop is the host's own foreground observation.
    const target = nextTarget()
    const { shutdown } = await establish(target, [
      hostEntry(target, {
        foregroundProcessEvidence: {
          ...OBSERVATION,
          verdict: 'live',
          processName: 'claude',
          shellOwnsEveryTtyProcessGroup: false
        }
      })
    ])

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('never stops a pane whose foreground observation the relay could not make', async () => {
    const target = nextTarget()
    const { shutdown } = await establish(target, [
      hostEntry(target, {
        foregroundProcessEvidence: {
          ...OBSERVATION,
          verdict: 'unverifiable',
          reason: 'table_unreadable'
        }
      })
    ])

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('never stops a PTY this relay attributes to a different client', async () => {
    const target = nextTarget()
    const { shutdown } = await establish(target, [
      hostEntry(target, { ownerClientInstanceId: 'someone-elses-laptop' })
    ])

    expect(shutdown).not.toHaveBeenCalled()
  })

  it('never stops anything a relay predating the attestation lists', async () => {
    const target = nextTarget()
    const legacy = hostEntry(target)
    delete legacy.ownerClientInstanceId
    delete legacy.hostAgeMs
    delete legacy.paneBound
    delete legacy.foregroundProcessEvidence

    const { shutdown } = await establish(target, [legacy])

    expect(shutdown).not.toHaveBeenCalled()
  })
})
