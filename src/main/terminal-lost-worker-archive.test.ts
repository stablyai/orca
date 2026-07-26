import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../shared/constants'
import {
  captureTerminalArchiveTab,
  retireArchivedTerminalTab,
  type TerminalArchiveSnapshotSource
} from '../shared/workspace-session-terminal-archive'
import type { WorkspaceSessionState } from '../shared/types'
import { TerminalArchiveStore, type TerminalArchiveRepository } from './terminal-archive-store'
import { archiveLostTerminalWorker } from './terminal-lost-worker-archive'

const WORKTREE_ID = 'repo-1::/worktree'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

function session(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [WORKTREE_ID]: [
        {
          id: TAB_ID,
          worktreeId: WORKTREE_ID,
          title: 'Worker',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 10,
          ptyId: 'pty-1'
        }
      ]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
      }
    },
    terminalPtyIncarnationsByPaneKey: { [`${TAB_ID}:${LEAF_ID}`]: 'incarnation-1' },
    terminalArchiveHintsByPaneKey: {
      [`${TAB_ID}:${LEAF_ID}`]: { launchAgent: 'codex', startedAt: 10 }
    }
  }
}

function owner(
  sessionState: WorkspaceSessionState,
  beforeArchiveFlush?: () => void,
  ownership: 'matching' | 'deny' = 'matching',
  retirement: 'matching' | 'deny' = 'matching'
) {
  let archives = {}
  let persistedSession = sessionState
  const repository: TerminalArchiveRepository = {
    getTerminalArchives: () => archives,
    replaceTerminalArchivesAndFlush: (next) => {
      beforeArchiveFlush?.()
      archives = next
    },
    getTerminalArchiveRetentionDays: () => 7,
    isExecutionHostReachable: () => true,
    worktreeExists: () => true,
    isTerminalArchiveRequestOwned: (request) => {
      if (ownership === 'deny') {
        return false
      }
      const captured = captureTerminalArchiveTab({
        session: persistedSession,
        worktreeId: request.worktreeId,
        tabId: request.sourceTabId
      })
      return Boolean(
        captured &&
        Object.keys(captured.sourcePaneIdentityByLeafId).length ===
          Object.keys(request.sourcePaneIdentityByLeafId).length &&
        Object.entries(captured.sourcePaneIdentityByLeafId).every(
          ([leafId, identity]) =>
            request.sourcePaneIdentityByLeafId[leafId]?.paneKey === identity.paneKey &&
            request.sourcePaneIdentityByLeafId[leafId]?.incarnationId === identity.incarnationId
        )
      )
    },
    isTerminalScrollbackSnapshotLive: () => false
  }
  const retireArchivedTerminalTabAndFlush = vi.fn((args: { worktreeId: string; tabId: string }) => {
    if (retirement === 'deny') {
      return {
        ...retireArchivedTerminalTab(persistedSession, args.worktreeId, args.tabId),
        closed: false,
        ptyIdsToKill: [],
        session: persistedSession
      }
    }
    return retireArchivedTerminalTab(persistedSession, args.worktreeId, args.tabId)
  })
  repository.commitLostTerminalArchiveAndRetire = (nextArchives, args) => {
    const retired = retireArchivedTerminalTabAndFlush(args)
    if (!retired.closed) {
      return retired
    }
    beforeArchiveFlush?.()
    archives = nextArchives
    persistedSession = retired.session
    return retired
  }
  return {
    archives: () => archives,
    retireArchivedTerminalTabAndFlush,
    value: {
      getWorkspaceSession: () => persistedSession,
      createTerminalArchiveStore: (snapshotSource: TerminalArchiveSnapshotSource) =>
        new TerminalArchiveStore(repository, snapshotSource, () => 100)
    }
  }
}

describe('archiveLostTerminalWorker', () => {
  it('archives before retiring and returns only main-owned kill authority', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession)

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'daemon-worker-lost',
        executionHostId: 'local',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'captured-empty' }) }
    })

    expect(result).toMatchObject({
      kind: 'archived',
      operationId: expect.stringMatching(/^daemon-worker-lost:tab-1:[0-9a-f]{64}$/)
    })
    expect(Object.keys(archiveOwner.archives())).toHaveLength(1)
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      executionHostId: 'local'
    })
  })

  it('deduplicates overlapping relay reconnect attempts and completes physical shutdown once', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession)
    let releaseCapture: (() => void) | undefined
    const capture = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseCapture = resolve
        }).then(() => ({ kind: 'captured-empty' as const }))
    )
    const request = {
      owner: archiveOwner.value,
      candidate: {
        reason: 'relay-worker-lost' as const,
        executionHostId: 'local' as const,
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture },
      completeArchive: vi.fn().mockResolvedValue(undefined)
    }

    const first = archiveLostTerminalWorker(request)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
    const second = archiveLostTerminalWorker(request)
    releaseCapture?.()

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: 'archived' }),
      expect.objectContaining({ kind: 'archived' })
    ])
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).toHaveBeenCalledOnce()
    expect(request.completeArchive).toHaveBeenCalledOnce()
  })

  it('keeps SSH pending retirement and shutdown completion inside the renderer-owned operation', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession)
    const completeArchive = vi.fn().mockResolvedValue(undefined)

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'relay-worker-lost',
        executionHostId: 'ssh:target-1',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        sshTerminationTargetId: 'target-1',
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'captured-empty' }) },
      completeArchive
    })

    expect(result).toMatchObject({ kind: 'archived' })
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      executionHostId: 'ssh:target-1',
      sshTerminationTargetId: 'target-1'
    })
    expect(completeArchive).toHaveBeenCalledOnce()
  })

  it('correlates post-commit completion failures with the operation and attempt', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession)
    const diagnostic = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'relay-worker-lost',
        executionHostId: 'ssh:target-1',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        attempt: 7,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'captured-empty' }) },
      completeArchive: vi.fn().mockRejectedValue(new Error('shutdown unavailable'))
    })

    expect(result).toMatchObject({ kind: 'archived' })
    expect(diagnostic).toHaveBeenCalledWith(
      '[terminal-lost-worker-archive] completion diagnostic',
      expect.objectContaining({
        attempt: 7,
        operationId: expect.stringMatching(/^relay-worker-lost:tab-1:[0-9a-f]{64}$/),
        error: 'shutdown unavailable'
      })
    )
    diagnostic.mockRestore()
  })

  it('checks the reconnect attempt fence before every pre-commit leaf capture', async () => {
    const secondLeafId = '22222222-2222-4222-8222-222222222222'
    const frozenSession = session()
    frozenSession.terminalLayoutsByTabId[TAB_ID] = {
      ...frozenSession.terminalLayoutsByTabId[TAB_ID],
      root: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: LEAF_ID },
        second: { type: 'leaf', leafId: secondLeafId }
      },
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-1', [secondLeafId]: 'pty-2' }
    }
    frozenSession.terminalPtyIncarnationsByPaneKey = {
      [`${TAB_ID}:${LEAF_ID}`]: 'incarnation-1',
      [`${TAB_ID}:${secondLeafId}`]: 'incarnation-2'
    }
    frozenSession.terminalArchiveHintsByPaneKey = {
      ...frozenSession.terminalArchiveHintsByPaneKey,
      [`${TAB_ID}:${secondLeafId}`]: { launchAgent: 'codex', startedAt: 10 }
    }
    const archiveOwner = owner(frozenSession)
    let attemptCurrent = true
    const capture = vi.fn(async () => {
      attemptCurrent = false
      return { kind: 'captured-empty' as const }
    })

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'relay-worker-lost',
        executionHostId: 'ssh:target-1',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' },
          [secondLeafId]: {
            paneKey: `${TAB_ID}:${secondLeafId}`,
            incarnationId: 'incarnation-2'
          }
        }
      },
      frozenSession,
      snapshotSource: { capture },
      isCaptureAttemptCurrent: () => attemptCurrent
    })

    expect(result).toEqual({ kind: 'error', code: 'capture-unavailable' })
    expect(capture).toHaveBeenCalledOnce()
    expect(archiveOwner.archives()).toEqual({})
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).not.toHaveBeenCalled()
  })

  it('continues completion after the archive commit loses the reconnect fence', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession)
    let attemptCurrent = true
    const completeArchive = vi.fn(async () => {
      attemptCurrent = false
    })

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'relay-worker-lost',
        executionHostId: 'ssh:target-1',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'captured-empty' }) },
      isCaptureAttemptCurrent: () => attemptCurrent,
      completeArchive
    })

    expect(result).toMatchObject({ kind: 'archived' })
    expect(completeArchive).toHaveBeenCalledOnce()
    expect(attemptCurrent).toBe(false)
  })

  it('uses the renderer completion when it wins a cross-entry SSH race', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession)
    let releaseCapture: (() => void) | undefined
    const capture = vi.fn(
      async () =>
        await new Promise<void>((resolve) => {
          releaseCapture = resolve
        }).then(() => ({ kind: 'captured-empty' as const }))
    )
    const rendererCompletion = vi.fn().mockResolvedValue(undefined)
    const relayCompletion = vi.fn().mockResolvedValue(undefined)
    const request = {
      owner: archiveOwner.value,
      candidate: {
        reason: 'relay-worker-lost' as const,
        executionHostId: 'ssh:target-1' as const,
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        sshTerminationTargetId: 'target-1',
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture },
      completeArchive: rendererCompletion
    }

    const renderer = archiveLostTerminalWorker(request)
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce())
    const relay = archiveLostTerminalWorker({ ...request, completeArchive: relayCompletion })
    releaseCapture?.()

    await expect(Promise.all([renderer, relay])).resolves.toEqual([
      expect.objectContaining({ kind: 'archived' }),
      expect.objectContaining({ kind: 'archived' })
    ])
    expect(rendererCompletion).toHaveBeenCalledOnce()
    expect(relayCompletion).not.toHaveBeenCalled()
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      tabId: TAB_ID,
      executionHostId: 'ssh:target-1',
      sshTerminationTargetId: 'target-1'
    })
  })

  it('does not write archive metadata when atomic retirement rejects the source', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession, undefined, 'matching', 'deny')

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'daemon-worker-lost',
        executionHostId: 'local',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'captured-empty' }) }
    })

    expect(result).toEqual({ kind: 'error', code: 'stale-source' })
    expect(archiveOwner.archives()).toEqual({})
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).toHaveBeenCalledOnce()
  })

  it('rejects a stale source incarnation before archive or retirement', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession)

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'relay-worker-lost',
        executionHostId: 'local',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'replacement' }
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'captured-empty' }) }
    })

    expect(result).toEqual({ kind: 'error', code: 'stale-source' })
    expect(archiveOwner.archives()).toEqual({})
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).not.toHaveBeenCalled()
  })

  it('rejects relay evidence whose source incarnation does not match the required CAS identity', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession)

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'relay-worker-lost',
        executionHostId: 'local',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        },
        relayEvidence: {
          id: 'relay-pty',
          paneKey: `${TAB_ID}:${LEAF_ID}`,
          sourceIncarnationId: 'stale-incarnation'
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'captured-empty' }) }
    })

    expect(result).toEqual({ kind: 'error', code: 'stale-source' })
    expect(archiveOwner.archives()).toEqual({})
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).not.toHaveBeenCalled()
  })

  it('maps an explicit Store ownership denial to a permanent not-owned result', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession, undefined, 'deny')

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'daemon-worker-lost',
        executionHostId: 'local',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'captured-empty' }) }
    })

    expect(result).toEqual({ kind: 'error', code: 'not-owned' })
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).not.toHaveBeenCalled()
  })

  it('keeps the tab live when capture or archive metadata durability fails', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession)

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'daemon-worker-lost',
        executionHostId: 'local',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'unavailable' }) }
    })

    expect(result).toEqual({ kind: 'error', code: 'capture-unavailable' })
    expect(archiveOwner.archives()).toEqual({})
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).not.toHaveBeenCalled()
  })

  it('keeps the tab live when archive metadata flush fails', async () => {
    const frozenSession = session()
    const archiveOwner = owner(frozenSession, () => {
      throw new Error('disk unavailable')
    })

    const result = await archiveLostTerminalWorker({
      owner: archiveOwner.value,
      candidate: {
        reason: 'daemon-worker-lost',
        executionHostId: 'local',
        worktreeId: WORKTREE_ID,
        tabId: TAB_ID,
        expectedSourcePaneIdentityByLeafId: {
          [LEAF_ID]: { paneKey: `${TAB_ID}:${LEAF_ID}`, incarnationId: 'incarnation-1' }
        }
      },
      frozenSession,
      snapshotSource: { capture: async () => ({ kind: 'captured-empty' }) }
    })

    expect(result).toEqual({ kind: 'error', code: 'durability-failed' })
    expect(archiveOwner.archives()).toEqual({})
    expect(archiveOwner.retireArchivedTerminalTabAndFlush).toHaveBeenCalledOnce()
  })
})
