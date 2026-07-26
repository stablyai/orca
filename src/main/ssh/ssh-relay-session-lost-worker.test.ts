import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RelayPtyLostEntry } from '../../shared/pty-revive-protocol'
import { decodeRelayStagedPtySnapshots } from '../../shared/relay-staged-pty-snapshots'
import { takeArchivedSshPtyExitRecovery } from './ssh-archived-exit-recovery'
import type { WorkspaceSessionState } from '../../shared/types'
import { createMockDeps, mockDeploySuccess } from './ssh-relay-session-test-fixtures'

const { muxRequestMock, archiveLostTerminalWorkerMock } = vi.hoisted(() => ({
  muxRequestMock: vi.fn(),
  archiveLostTerminalWorkerMock: vi.fn()
}))

vi.mock('./ssh-relay-deploy', () => ({ deployAndLaunchRelay: vi.fn() }))
vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: vi.fn().mockResolvedValue('') }))
vi.mock('../terminal-lost-worker-archive', () => ({
  archiveLostTerminalWorker: archiveLostTerminalWorkerMock
}))
vi.mock('./ssh-channel-multiplexer', () => ({
  SshChannelMultiplexer: class MockSshChannelMultiplexer {
    notify = vi.fn()
    request = muxRequestMock
    onNotification = vi.fn().mockReturnValue(() => {})
    onRequest = vi.fn().mockReturnValue(() => {})
    onDispose = vi.fn().mockReturnValue(() => {})
    dispose = vi.fn()
    isDisposed = vi.fn().mockReturnValue(false)
  }
}))
vi.mock('../providers/ssh-pty-provider', () => ({
  isSshPtyNotFoundError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('not found'),
  isSshPtyIdentityMismatchError: (err: unknown) =>
    (err instanceof Error ? err.message : String(err)).includes('identity mismatch'),
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
  getSshPtyProvider: vi.fn().mockReturnValue({
    dispose: vi.fn(),
    attach: vi.fn().mockResolvedValue(undefined),
    attachForReconnect: vi.fn().mockResolvedValue({})
  }),
  getPtyIdsForConnection: vi.fn().mockReturnValue([]),
  clearPtyOwnershipForConnection: vi.fn(),
  clearProviderPtyState: vi.fn(),
  deletePtyOwnership: vi.fn(),
  setPtyOwnership: vi.fn(),
  restorePtyIncarnation: vi.fn(),
  isCurrentPtyExit: vi.fn(() => true)
}))
vi.mock('../ipc/pty-renderer-delivery-router', () => ({
  routeExternalPtyData: vi.fn(),
  routeExternalPtyReplay: vi.fn(),
  routeExternalPtyExit: vi.fn()
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
const { routeExternalPtyExit } = await import('../ipc/pty-renderer-delivery-router')

const REVIVE_WORKTREE_ID = 'repo-1::/worktree'
const REVIVE_TAB_ID = 'tab-1'
const REVIVE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const REVIVE_PANE_KEY = `${REVIVE_TAB_ID}:${REVIVE_LEAF_ID}`
const RELAY_LOST_WORKER: RelayPtyLostEntry = {
  id: 'ssh:target-1@@pty-lost',
  kind: 'recognized-worker',
  reason: 'process-not-running',
  pid: 42,
  cols: 80,
  rows: 24,
  cwd: '/repo',
  worktreeId: REVIVE_WORKTREE_ID,
  tabId: REVIVE_TAB_ID,
  paneKey: REVIVE_PANE_KEY
}

function workspaceSessionForRelayLostWorker(workerHint = false): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [REVIVE_WORKTREE_ID]: [
        {
          id: REVIVE_TAB_ID,
          worktreeId: REVIVE_WORKTREE_ID,
          title: 'Worker',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 10,
          ptyId: RELAY_LOST_WORKER.id
        }
      ]
    },
    terminalLayoutsByTabId: {
      [REVIVE_TAB_ID]: {
        root: { type: 'leaf', leafId: REVIVE_LEAF_ID },
        activeLeafId: REVIVE_LEAF_ID,
        expandedLeafId: null
      }
    },
    terminalPtyIncarnationsByPaneKey: { [REVIVE_PANE_KEY]: 'incarnation-1' },
    terminalArchiveHintsByPaneKey: {
      [REVIVE_PANE_KEY]: workerHint ? { launchAgent: 'codex', startedAt: 10 } : { cwd: '/repo' }
    }
  }
}

function configureStagedPtyRevive(args: {
  serialize: ReturnType<typeof vi.fn>
  revive: ReturnType<typeof vi.fn>
  reattachPtyIds?: string[]
}): { attachForReconnect: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn> } {
  const attachForReconnect = vi.fn().mockResolvedValue({})
  const shutdown = vi.fn().mockResolvedValue(undefined)
  vi.mocked(getSshPtyProvider)
    .mockReset()
    .mockReturnValueOnce({
      serialize: args.serialize,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    .mockReturnValue({
      revive: args.revive,
      shutdown,
      attachForReconnect,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
  vi.mocked(getPtyIdsForConnection).mockReturnValueOnce(['ssh:target-1@@pty-lost'])
  vi.mocked(getPtyIdsForConnection).mockReturnValue(args.reattachPtyIds ?? [])
  return { attachForReconnect, shutdown }
}

async function establishRelaySession() {
  const deps = createMockDeps()
  const session = new SshRelaySession(
    'target-1',
    deps.getMainWindow,
    deps.mockStore,
    deps.mockPortForward
  )
  await session.establish(deps.mockConn)
  return { ...deps, session }
}

type SshRelaySessionArchiveInternals = {
  archiveRelayLostWorker: (args: {
    lost: RelayPtyLostEntry
    session: WorkspaceSessionState
    stagedSnapshots: ReturnType<typeof decodeRelayStagedPtySnapshots>
  }) => Promise<void>
  archiveRelayLostWorkerGroups: (
    lost: readonly RelayPtyLostEntry[],
    stagedSnapshots: ReturnType<typeof decodeRelayStagedPtySnapshots>
  ) => Promise<void>
  reattachKnownPtys: (shouldContinue: () => boolean) => Promise<void>
  retryTerminationPendingPtys: () => Promise<void>
  shutdownArchivedRelayPtys: (
    ptyIds: readonly string[],
    archiveId: string,
    tabId: string
  ) => Promise<void>
}

function archiveInternals(session: SshRelaySession): SshRelaySessionArchiveInternals {
  return session as unknown as SshRelaySessionArchiveInternals
}

describe('SshRelaySession lost-worker archive', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.ORCA_FEATURE_REMOTE_AGENT_HOOKS
    muxRequestMock.mockReset()
    muxRequestMock.mockResolvedValue([])
    archiveLostTerminalWorkerMock.mockReset()
    vi.mocked(getSshPtyProvider)
      .mockReset()
      .mockReturnValue({
        dispose: vi.fn(),
        attach: vi.fn().mockResolvedValue(undefined),
        attachForReconnect: vi.fn().mockResolvedValue({})
      } as unknown as ReturnType<typeof getSshPtyProvider>)
    mockDeploySuccess()
    vi.mocked(getPtyIdsForConnection).mockReturnValue([])
  })

  it.each([
    'typed recognized',
    'typed unclassified worker hint',
    'typed unclassified',
    'legacy',
    'malformed typed',
    'serialize failure',
    'archive failure'
  ])('keeps staged PTY revive %s on its compatible recovery path', async (state) => {
    const { mockConn, mockStore, session } = await establishRelaySession()
    vi.clearAllMocks()
    mockDeploySuccess()
    const serialize = vi.fn().mockResolvedValue('staged-pty-state')
    const revive = vi.fn()
    const lost = state.startsWith('typed unclassified')
      ? { ...RELAY_LOST_WORKER, kind: 'unclassified' as const }
      : RELAY_LOST_WORKER
    if (state === 'serialize failure') {
      serialize.mockRejectedValue(new Error('old relay stopped before serialize reply'))
    } else if (state === 'malformed typed') {
      revive.mockRejectedValue(new Error('typed outcome validation failed'))
    } else if (state === 'legacy') {
      revive.mockResolvedValue({
        mode: 'legacy',
        diagnosticCode: 'pty-revive-outcome-unavailable',
        outcome: { outcomeVersion: 1, revived: [], lost: [RELAY_LOST_WORKER], diagnostics: [] }
      })
    } else {
      revive.mockResolvedValue({
        mode: 'typed',
        outcome: { outcomeVersion: 1, revived: [], lost: [lost], diagnostics: [] }
      })
    }
    if (state === 'archive failure') {
      archiveLostTerminalWorkerMock.mockResolvedValue({ kind: 'error', code: 'durability-failed' })
    } else {
      archiveLostTerminalWorkerMock.mockImplementation(async ({ completeArchive }) => {
        const result = {
          kind: 'archived' as const,
          archive: { id: 'archive-1' },
          operationId: 'relay-worker-lost:tab-1',
          ptyIdsToKill: [RELAY_LOST_WORKER.id]
        }
        await completeArchive?.(result)
        return result
      })
    }
    mockStore.getWorkspaceSession = vi
      .fn()
      .mockReturnValue(
        workspaceSessionForRelayLostWorker(state === 'typed unclassified worker hint')
      )
    const archived = state === 'typed recognized' || state === 'typed unclassified worker hint'
    const fallbackPtyIds = archived ? [] : ['ssh:target-1@@pty-fallback']
    const { attachForReconnect } = configureStagedPtyRevive({
      serialize,
      revive,
      reattachPtyIds: fallbackPtyIds
    })

    await session.reconnect(mockConn)

    expect(serialize).toHaveBeenCalledWith(['pty-lost'], { formatVersion: 2 })
    expect(revive).toHaveBeenCalledTimes(state === 'serialize failure' ? 0 : 1)
    expect(archiveLostTerminalWorkerMock).toHaveBeenCalledTimes(
      archived || state === 'archive failure' ? 1 : 0
    )
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledTimes(
      archived ? 1 : fallbackPtyIds.length
    )
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      'target-1',
      archived ? 'pty-lost' : 'pty-fallback',
      archived ? 'terminated' : 'attached'
    )
    if (archived) {
      expect(routeExternalPtyExit).toHaveBeenCalledWith({
        id: RELAY_LOST_WORKER.id,
        code: -1,
        lostWorkerRecovery: { kind: 'archived', archiveId: 'archive-1' }
      })
    } else {
      expect(routeExternalPtyExit).not.toHaveBeenCalled()
    }
    expect(session.getState()).toBe('ready')
    if (state === 'typed unclassified') {
      expect(mockStore.getWorkspaceSession).toHaveBeenCalledWith('ssh:target-1')
    }
    if (state === 'typed unclassified worker hint') {
      expect(archiveLostTerminalWorkerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({
            relayEvidence: expect.objectContaining({ kind: 'unclassified' })
          })
        })
      )
    }
    if (fallbackPtyIds.length > 0) {
      expect(attachForReconnect).toHaveBeenCalledWith('pty-fallback')
    }
    if (state === 'archive failure') {
      expect(archiveLostTerminalWorkerMock).toHaveBeenCalledWith(
        expect.objectContaining({
          candidate: expect.objectContaining({ relayEvidence: RELAY_LOST_WORKER })
        })
      )
      expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalledWith(
        'target-1',
        'pty-lost',
        'expired'
      )
    }
  })

  it('selects worker evidence when an ordinary loss appears first in its tab group', async () => {
    const { mockStore, session } = await establishRelaySession()
    const persistedSession = workspaceSessionForRelayLostWorker()
    mockStore.getWorkspaceSession = vi.fn().mockReturnValue(persistedSession)
    archiveLostTerminalWorkerMock.mockResolvedValue({ kind: 'error', code: 'capture-unavailable' })

    await archiveInternals(session).archiveRelayLostWorkerGroups(
      [
        { ...RELAY_LOST_WORKER, id: 'ssh:target-1@@ordinary-first', kind: 'ordinary-shell' },
        RELAY_LOST_WORKER
      ],
      decodeRelayStagedPtySnapshots(JSON.stringify({ schemaVersion: 2, entries: [] }))
    )

    expect(archiveLostTerminalWorkerMock).toHaveBeenCalledOnce()
    expect(archiveLostTerminalWorkerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        candidate: expect.objectContaining({ relayEvidence: RELAY_LOST_WORKER })
      })
    )
  })

  it('does not repeat physical shutdown when this reconnect joined an in-flight archive', async () => {
    const { mockConn, mockStore, session } = await establishRelaySession()
    const serialize = vi.fn().mockResolvedValue('staged-pty-state')
    const revive = vi.fn().mockResolvedValue({
      mode: 'typed',
      outcome: { outcomeVersion: 1, revived: [], lost: [RELAY_LOST_WORKER], diagnostics: [] }
    })
    archiveLostTerminalWorkerMock.mockResolvedValue({
      kind: 'archived',
      archive: { id: 'archive-1' },
      operationId: 'relay-worker-lost:tab-1',
      ptyIdsToKill: [RELAY_LOST_WORKER.id]
    })
    mockStore.getWorkspaceSession = vi.fn().mockReturnValue(workspaceSessionForRelayLostWorker())
    const { shutdown } = configureStagedPtyRevive({ serialize, revive })

    await session.reconnect(mockConn)

    expect(shutdown).not.toHaveBeenCalled()
    expect(routeExternalPtyExit).not.toHaveBeenCalled()
  })

  it('releases synthetic archive-exit recovery registrations after routing the receipt', async () => {
    const { session } = await establishRelaySession()
    const shutdown = vi.fn().mockResolvedValue(undefined)
    vi.mocked(getSshPtyProvider).mockReturnValue({
      shutdown,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)

    await archiveInternals(session).shutdownArchivedRelayPtys(
      [RELAY_LOST_WORKER.id],
      'archive-1',
      REVIVE_TAB_ID
    )

    expect(takeArchivedSshPtyExitRecovery(RELAY_LOST_WORKER.id)).toBeUndefined()
    expect(routeExternalPtyExit).toHaveBeenCalledWith({
      id: RELAY_LOST_WORKER.id,
      code: -1,
      lostWorkerRecovery: { kind: 'archived', archiveId: 'archive-1' }
    })
  })

  it('fails closed with the legacy-envelope diagnostic instead of fabricating a tail', async () => {
    const { mockStore, session } = await establishRelaySession()
    const persistedSession = workspaceSessionForRelayLostWorker()
    mockStore.getWorkspaceSession = vi.fn().mockReturnValue(persistedSession)
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {})
    archiveLostTerminalWorkerMock.mockImplementation(async ({ snapshotSource }) => {
      await expect(
        snapshotSource.capture({ archivedLeafId: REVIVE_LEAF_ID, cwd: '/repo' })
      ).resolves.toEqual({ kind: 'unavailable' })
      return { kind: 'error', code: 'capture-unavailable' }
    })

    await archiveInternals(session).archiveRelayLostWorker({
      lost: RELAY_LOST_WORKER,
      session: persistedSession,
      stagedSnapshots: decodeRelayStagedPtySnapshots(JSON.stringify([]))
    })

    expect(diagnostic).toHaveBeenCalledWith(
      '[ssh-relay-session] lost-worker archive diagnostic',
      expect.objectContaining({
        stage: 'staged-state-legacy',
        paneKey: REVIVE_PANE_KEY,
        attempt: expect.any(Number)
      })
    )
    diagnostic.mockRestore()
  })

  it('keeps a failed physical shutdown pending, excludes it from reattach, and retries it', async () => {
    const { mockStore, session } = await establishRelaySession()
    const shutdown = vi
      .fn()
      .mockRejectedValueOnce(new Error('remote unavailable'))
      .mockResolvedValueOnce(undefined)
    const attachForReconnect = vi.fn()
    vi.mocked(getSshPtyProvider).mockReturnValue({
      shutdown,
      attachForReconnect,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    vi.mocked(mockStore.getSshRemotePtyLeases).mockReturnValue([
      {
        targetId: 'target-1',
        ptyId: 'pty-lost',
        state: 'termination-pending',
        worktreeId: REVIVE_WORKTREE_ID,
        tabId: REVIVE_TAB_ID,
        leafId: REVIVE_LEAF_ID
      }
    ] as ReturnType<typeof mockStore.getSshRemotePtyLeases>)

    await archiveInternals(session).retryTerminationPendingPtys()
    await archiveInternals(session).reattachKnownPtys(() => true)
    expect(mockStore.markSshRemotePtyLease).not.toHaveBeenCalled()
    expect(attachForReconnect).not.toHaveBeenCalled()

    await archiveInternals(session).retryTerminationPendingPtys()
    expect(shutdown).toHaveBeenCalledTimes(2)
    expect(mockStore.markSshRemotePtyLease).toHaveBeenCalledWith(
      'target-1',
      'pty-lost',
      'terminated'
    )
  })
})
