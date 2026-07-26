import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SshRelaySession } from './ssh-relay-session'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { RelayPtyLostEntry } from '../../shared/pty-revive-protocol'
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
}): { attachForReconnect: ReturnType<typeof vi.fn> } {
  const attachForReconnect = vi.fn().mockResolvedValue({})
  vi.mocked(getSshPtyProvider)
    .mockReset()
    .mockReturnValueOnce({
      serialize: args.serialize,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
    .mockReturnValue({
      revive: args.revive,
      attachForReconnect,
      dispose: vi.fn()
    } as unknown as ReturnType<typeof getSshPtyProvider>)
  vi.mocked(getPtyIdsForConnection).mockReturnValueOnce(['ssh:target-1@@pty-lost'])
  vi.mocked(getPtyIdsForConnection).mockReturnValue(args.reattachPtyIds ?? [])
  return { attachForReconnect }
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
    archiveLostTerminalWorkerMock.mockResolvedValue(
      state === 'archive failure'
        ? { kind: 'error', code: 'durability-failed' }
        : {
            kind: 'archived',
            archive: { id: 'archive-1' },
            operationId: 'relay-worker-lost:tab-1',
            ptyIdsToKill: [RELAY_LOST_WORKER.id]
          }
    )
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
      archived ? 'expired' : 'attached'
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
})
