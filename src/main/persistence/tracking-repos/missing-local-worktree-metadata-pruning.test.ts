import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Project } from '../../../shared/project/project-types'
import type { Repo } from '../../../shared/repository/repo-types'
import type { SshRemotePtyLease } from '../../../shared/remote-runtime/ssh/ssh-types'
import { worktreeWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import {
  captureNativeLocalWorktreeMetadataScanExpectation,
  pruneSessionlessMissingLocalWorktreeMetadataForRepo
} from './missing-local-worktree-metadata-pruning'
import { pruneMissingLocalWorktreeSessionsForRepo } from './missing-local-worktree-session-pruning'

const REPO_ID = 'repo-1'
const LIVE_ID = `${REPO_ID}::/workspace/live`

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: REPO_ID,
    path: '/workspace/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

function makeMeta(worktreeId: string): WorktreeMeta {
  return {
    instanceId: `instance-${worktreeId}`,
    hostId: 'local',
    displayName: worktreeId,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeState(repo = makeRepo()): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [repo]
  return state
}

function capture(state: PersistedState, repo = state.repos[0]!) {
  return captureNativeLocalWorktreeMetadataScanExpectation(state, repo)
}

function pruneCaptured(
  state: PersistedState,
  scan: ReturnType<typeof capture>,
  ids: readonly string[],
  platform?: NodeJS.Platform
): string[] {
  const wanted = new Set(ids)
  return pruneSessionlessMissingLocalWorktreeMetadataForRepo(
    state,
    scan,
    scan.metadata.filter(({ worktreeId }) => wanted.has(worktreeId)),
    platform
  )
}

describe('pruneSessionlessMissingLocalWorktreeMetadataForRepo', () => {
  it('removes 2,709 sessionless rows in one batch without cloning or changing session state', () => {
    const state = makeState()
    const staleIds = Array.from(
      { length: 2_709 },
      (_, index) => `${REPO_ID}::/workspace/stale-${index}`
    )
    const allIds = [LIVE_ID, ...staleIds]
    state.worktreeMetaByIdentity = {}
    state.worktreeIdentityAliases = {}
    for (const [index, worktreeId] of allIds.entries()) {
      const meta = makeMeta(worktreeId)
      const identityKey = `identity-${index}`
      state.worktreeMeta[worktreeId] = meta
      state.worktreeMetaByIdentity[identityKey] = meta
      state.worktreeIdentityAliases[`local|${worktreeId}`] = [identityKey]
    }
    state.worktreeLineageById[staleIds[0]!] = { worktreeId: staleIds[0] } as never
    state.workspaceLineageByChildKey[worktreeWorkspaceKey(staleIds[0]!)] = {
      childWorkspaceKey: worktreeWorkspaceKey(staleIds[0]!)
    } as never
    state.workspaceSession.terminalTopologyRevisionByRepoId = { [REPO_ID]: 7 }
    const hostSession = {
      ...getDefaultWorkspaceSession(),
      terminalTopologyRevisionByRepoId: { [REPO_ID]: 11 }
    }
    state.workspaceSessionsByHostId = { 'runtime:mirror': hostSession }
    const scan = capture(state)
    const session = state.workspaceSession
    const sessionSnapshot = structuredClone(session)
    const hostSessionSnapshot = structuredClone(hostSession)
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone')

    const removed = pruneCaptured(state, scan, staleIds)

    expect(removed).toHaveLength(staleIds.length)
    expect(cloneSpy).not.toHaveBeenCalled()
    cloneSpy.mockRestore()
    expect(Object.keys(state.worktreeMeta)).toEqual([LIVE_ID])
    expect(Object.keys(state.worktreeMetaByIdentity ?? {})).toEqual(['identity-0'])
    expect(Object.keys(state.worktreeIdentityAliases ?? {})).toEqual([`local|${LIVE_ID}`])
    expect(state.worktreeLineageById[staleIds[0]!]).toBeUndefined()
    expect(state.workspaceLineageByChildKey[worktreeWorkspaceKey(staleIds[0]!)]).toBeUndefined()
    expect(state.workspaceSession).toBe(session)
    expect(state.workspaceSession).toEqual(sessionSnapshot)
    expect(state.workspaceSessionsByHostId?.['runtime:mirror']).toBe(hostSession)
    expect(state.workspaceSessionsByHostId?.['runtime:mirror']).toEqual(hostSessionSnapshot)
  })

  it('fails closed when an identical repo row is removed and re-added during the scan', () => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/re-added-repo`
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    const scan = capture(state)
    const replacement = { ...state.repos[0]! }
    state.repos.splice(0, 1, replacement)

    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    expect(state.repos[0]).toBe(replacement)
    expect(state.worktreeMeta[worktreeId]).toBeDefined()
  })

  it('keeps an archived workspace whose checkout was deleted on purpose', () => {
    const state = makeState()
    const archivedId = `${REPO_ID}::/workspace/archived`
    const deletedId = `${REPO_ID}::/workspace/deleted`
    state.worktreeMeta[archivedId] = {
      ...makeMeta(archivedId),
      comment: 'pick up after review',
      linkedPR: 42,
      isArchived: true,
      archivedCheckout: { branch: 'feature/archived', archivedAt: 1 }
    }
    state.worktreeMeta[deletedId] = makeMeta(deletedId)
    const scan = capture(state)

    expect(pruneCaptured(state, scan, [archivedId, deletedId])).toEqual([deletedId])
    expect(state.worktreeMeta[archivedId]).toMatchObject({
      comment: 'pick up after review',
      linkedPR: 42
    })
  })

  // Route-retired tombstones must not pin metadata forever (#17775).
  it('does not let route-retired SSH leases pin a metadata row', () => {
    const state = makeState()
    const liveIds = Array.from({ length: 3 }, (_, i) => `${REPO_ID}::/workspace/live-${i}`)
    const terminatedIds = Array.from({ length: 5 }, (_, i) => `${REPO_ID}::/workspace/closed-${i}`)
    const supersededIds = Array.from({ length: 4 }, (_, i) => `${REPO_ID}::/workspace/lost-${i}`)
    const recycledIds = [`${REPO_ID}::/workspace/recycled`]
    const allIds = [...liveIds, ...terminatedIds, ...supersededIds, ...recycledIds]
    for (const worktreeId of allIds) {
      state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    }
    const lease = (worktreeId: string, index: number, extra: Partial<SshRemotePtyLease>) => ({
      targetId: 'builder',
      ptyId: `pty-${index}`,
      worktreeId,
      createdAt: 1,
      updatedAt: 1,
      ...extra
    })
    state.sshRemotePtyLeases = [
      ...liveIds.map((id, i) => lease(id, i, { state: 'detached' })),
      ...terminatedIds.map((id, i) => lease(id, 100 + i, { state: 'terminated' })),
      ...supersededIds.map((id, i) =>
        lease(id, 200 + i, { state: 'expired', supersededBy: 'pty-9' })
      ),
      ...recycledIds.map((id, i) => lease(id, 300 + i, { state: 'expired', relayIdRecycled: true }))
    ] as never

    const scan = capture(state)

    expect(pruneCaptured(state, scan, allIds).sort()).toEqual(
      [...terminatedIds, ...supersededIds, ...recycledIds].sort()
    )
    expect(Object.keys(state.worktreeMeta).sort()).toEqual([...liveIds].sort())
  })

  it('preserves foreign aliases, ambiguous local aliases, and divergent projections', () => {
    const foreignState = makeState()
    const foreignId = `${REPO_ID}::/workspace/foreign-alias`
    const localMeta = makeMeta(foreignId)
    const remoteMeta = { ...localMeta, hostId: 'ssh:builder' as const }
    foreignState.worktreeMeta[foreignId] = localMeta
    foreignState.worktreeMetaByIdentity = { local: localMeta, remote: remoteMeta }
    foreignState.worktreeIdentityAliases = {
      [`local|${foreignId}`]: ['local'],
      [`ssh:builder|${foreignId}`]: ['remote']
    }
    const foreignScan = capture(foreignState)

    expect(pruneCaptured(foreignState, foreignScan, [foreignId])).toEqual([])
    expect(foreignState.worktreeMetaByIdentity).toEqual({ local: localMeta, remote: remoteMeta })

    const ambiguousState = makeState()
    const ambiguousId = `${REPO_ID}::/workspace/ambiguous`
    const first = makeMeta(ambiguousId)
    ambiguousState.worktreeMeta[ambiguousId] = first
    ambiguousState.worktreeMetaByIdentity = { first, second: { ...first } }
    ambiguousState.worktreeIdentityAliases = { [`local|${ambiguousId}`]: ['first', 'second'] }
    expect(pruneCaptured(ambiguousState, capture(ambiguousState), [ambiguousId])).toEqual([])

    const divergentState = makeState()
    const divergentId = `${REPO_ID}::/workspace/divergent`
    const legacy = makeMeta(divergentId)
    const canonical = { ...legacy, comment: 'newer canonical comment' }
    divergentState.worktreeMeta[divergentId] = legacy
    divergentState.worktreeMetaByIdentity = { canonical }
    divergentState.worktreeIdentityAliases = { [`local|${divergentId}`]: ['canonical'] }
    const divergentScan = capture(divergentState)
    expect(pruneCaptured(divergentState, divergentScan, [divergentId])).toEqual([])
  })

  it('fails closed when project runtime routing changes away and back during the scan', () => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/project-routing-race`
    const project: Project = {
      id: 'project-1',
      displayName: 'project',
      badgeColor: '#000',
      localWindowsRuntimePreference: { kind: 'windows-host' },
      sourceRepoIds: [REPO_ID],
      createdAt: 1,
      updatedAt: 1
    }
    state.projects = [project]
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    const scan = capture(state)
    project.localWindowsRuntimePreference = { kind: 'wsl', distro: 'Ubuntu' }
    project.updatedAt += 1
    project.localWindowsRuntimePreference = { kind: 'windows-host' }
    project.updatedAt += 1

    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    expect(state.worktreeMeta[worktreeId]).toBeDefined()
  })

  it('fails closed when global runtime routing changes away and back during the scan', () => {
    const state = makeState()
    const worktreeId = `${REPO_ID}::/workspace/settings-routing-race`
    const originalDefault = state.settings.localWindowsRuntimeDefault
    state.worktreeMeta[worktreeId] = makeMeta(worktreeId)
    const scan = capture(state)
    state.settings = {
      ...state.settings,
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    }
    state.settings = {
      ...state.settings,
      localWindowsRuntimeDefault: originalDefault
    }

    expect(state.settings.localWindowsRuntimeDefault).toEqual(originalDefault)
    expect(pruneCaptured(state, scan, [worktreeId])).toEqual([])
    expect(state.worktreeMeta[worktreeId]).toBeDefined()
  })
})

describe('pruneMissingLocalWorktreeSessionsForRepo', () => {
  it('drops saved tabs of deleted worktrees but keeps unsaved drafts, archived and active workspaces', () => {
    const state = makeState()
    const goneId = `${REPO_ID}::/workspace/gone`
    const draftId = `${REPO_ID}::/workspace/draft`
    const archivedId = `${REPO_ID}::/workspace/archived`
    const activeId = `${REPO_ID}::/workspace/active`
    state.worktreeMeta[archivedId] = {
      ...makeMeta(archivedId),
      isArchived: true,
      archivedCheckout: { branch: 'feature/archived', archivedAt: 1 }
    }
    const draft = {
      filePath: '/workspace/draft/notes.md',
      relativePath: 'notes.md',
      worktreeId: draftId,
      language: 'markdown',
      dirtyDraftContent: 'unsaved'
    }
    state.workspaceSession = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: activeId,
      unifiedTabs: {
        [goneId]: [],
        [draftId]: [],
        [archivedId]: [],
        [activeId]: []
      },
      activeTabIdByWorktree: { [goneId]: null },
      openFilesByWorktree: { [draftId]: [draft] }
    }

    const removed = pruneMissingLocalWorktreeSessionsForRepo(
      state,
      capture(state),
      [goneId, draftId, archivedId, activeId],
      'linux'
    )

    expect(removed).toEqual([goneId])
    expect(state.workspaceSession.unifiedTabs).toEqual({
      [draftId]: [],
      [archivedId]: [],
      [activeId]: []
    })
    expect(state.workspaceSession.activeTabIdByWorktree).toEqual({})
    expect(state.workspaceSession.openFilesByWorktree).toEqual({ [draftId]: [draft] })
  })

  it('keeps an archived workspace whose saved key differs only in Windows path casing', () => {
    const state = makeState(makeRepo({ path: 'C:\\Work\\repo' }))
    state.worktreeMeta[`${REPO_ID}::C:\\Work\\archived`] = {
      ...makeMeta(`${REPO_ID}::C:\\Work\\archived`),
      isArchived: true,
      archivedCheckout: { branch: 'feature/archived', archivedAt: 1 }
    }
    const savedKey = `${REPO_ID}::c:\\work\\archived`
    state.workspaceSession = { ...getDefaultWorkspaceSession(), unifiedTabs: { [savedKey]: [] } }

    expect(
      pruneMissingLocalWorktreeSessionsForRepo(state, capture(state), [savedKey], 'win32')
    ).toEqual([])
    expect(state.workspaceSession.unifiedTabs).toEqual({ [savedKey]: [] })
  })

  it('keeps a workspace marked archived without an archived checkout', () => {
    const state = makeState()
    const archivedId = `${REPO_ID}::/workspace/hidden`
    state.worktreeMeta[archivedId] = { ...makeMeta(archivedId), isArchived: true }
    state.workspaceSession = { ...getDefaultWorkspaceSession(), unifiedTabs: { [archivedId]: [] } }

    expect(
      pruneMissingLocalWorktreeSessionsForRepo(state, capture(state), [archivedId], 'linux')
    ).toEqual([])
    expect(state.workspaceSession.unifiedTabs).toEqual({ [archivedId]: [] })
  })

  // A reference removal never deletes must not count as pruned, or every scan re-arms cleanup.
  it('reports nothing and keeps the session when only a kept close intent names the worktree', () => {
    const state = makeState()
    const goneId = `${REPO_ID}::/workspace/gone`
    const session = {
      ...getDefaultWorkspaceSession(),
      pairedTerminalTabCloseIntentsByEnvironment: {
        env: [{ hostTabIds: ['host-tab'], worktreeId: goneId, closedAt: 1 }]
      }
    }
    state.workspaceSession = session

    expect(
      pruneMissingLocalWorktreeSessionsForRepo(state, capture(state), [goneId], 'linux')
    ).toEqual([])
    expect(state.workspaceSession).toBe(session)
  })

  it('keeps a workspace whose draft is saved under a differently cased Windows key', () => {
    const state = makeState(makeRepo({ path: 'C:\\Work\\repo' }))
    const draftKey = `${REPO_ID}::C:\\Work\\gone`
    const tabsKey = `${REPO_ID}::c:\\work\\gone`
    state.workspaceSession = {
      ...getDefaultWorkspaceSession(),
      unifiedTabs: { [tabsKey]: [] },
      openFilesByWorktree: {
        [draftKey]: [
          {
            filePath: 'C:\\Work\\gone\\notes.md',
            relativePath: 'notes.md',
            worktreeId: draftKey,
            language: 'markdown',
            dirtyDraftContent: 'unsaved'
          }
        ]
      }
    }

    expect(
      pruneMissingLocalWorktreeSessionsForRepo(state, capture(state), [tabsKey], 'win32')
    ).toEqual([])
    expect(state.workspaceSession.unifiedTabs).toEqual({ [tabsKey]: [] })
  })
})
