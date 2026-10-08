import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { Tab } from '../../../shared/tab-types'
import { subtractOrcadMigrationClientState } from './orcad-source-client-subtraction'
import { collectOrcadMigrationUntransferredDependencyCensus } from './orcad-source-dependency-census'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import { subtractOrcadMigrationSourceDormantState } from './orcad-source-dormant-subtraction'
import {
  orcadMigrationOwnerMatchesScope,
  createOrcadMigrationSourceScope
} from './orcad-source-scope'

// Two SSH hosts registered the same repository id; only host A converts.
const REPO: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  displayName: 'Repository',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: 'host-a'
}
const WORKTREE = `${REPO.id}::/srv/repo`
const HOST_B = 'ssh:host-b'

function tab(id: string): Tab {
  return {
    id,
    entityId: `/srv/repo/${id}.md`,
    groupId: `group-${id}`,
    worktreeId: WORKTREE,
    contentType: 'editor',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function manifest(state: PersistedState): OrcadMigrationManifest {
  const source = { sshTargetId: 'host-a', sshTargetGeneration: null, targetLabel: 'A' }
  const payload = { repositories: [REPO], projectGroups: [], folderWorkspaces: [] }
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-1',
    createdAt: '2026-10-05T12:00:00.000Z',
    source,
    payload: {
      ...payload,
      dormantState: collectOrcadMigrationSourceDormantState(
        state,
        source,
        payload,
        undefined,
        'env-1'
      ).payload
    },
    destinationEnvironmentId: 'env-1',
    manifestSha256: 'a'.repeat(64)
  }
}

function twoHostState(): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [REPO, { ...REPO, connectionId: 'host-b' }]
  state.workspaceSessionsByHostId = {
    'ssh:host-a': { ...state.workspaceSession, unifiedTabs: { [WORKTREE]: [tab('a')] } },
    [HOST_B]: { ...state.workspaceSession, unifiedTabs: { [WORKTREE]: [tab('b')] } }
  }
  // Host B's row, qualified, in the local partition.
  state.workspaceSession.unifiedTabs = { [`${HOST_B}|${WORKTREE}`]: [tab('b-local')] }
  state.worktreeMeta[`${HOST_B}|${WORKTREE}`] = {
    displayName: 'B worktree',
    comment: '',
    isUnread: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    hostId: HOST_B
  }
  return state
}

describe('migration scope with host-qualified owners', () => {
  const scope = createOrcadMigrationSourceScope({
    source: { sshTargetId: 'host-a', sshTargetGeneration: null, targetLabel: 'A' },
    catalog: { repositories: [REPO], projectGroups: [], folderWorkspaces: [] },
    repos: [REPO]
  })

  it('owns only keys qualified with its own host', () => {
    expect(orcadMigrationOwnerMatchesScope(`ssh:host-a|${WORKTREE}`, scope)).toBe(true)
    expect(orcadMigrationOwnerMatchesScope(`${HOST_B}|${WORKTREE}`, scope)).toBe(false)
    expect(orcadMigrationOwnerMatchesScope(`runtime:env-1|${WORKTREE}`, scope)).toBe(false)
    expect(orcadMigrationOwnerMatchesScope(WORKTREE, scope)).toBe(true)
  })

  it("never moves, counts or retires another host's state that shares a repo id", () => {
    const state = twoHostState()
    const moved = manifest(state)
    const session = moved.payload.dormantState?.workspaceSession
    expect(
      Object.values(session?.unifiedTabs ?? {})
        .flat()
        .map((entry) => entry.id)
    ).toEqual(['a'])
    expect(
      collectOrcadMigrationUntransferredDependencyCensus(state, moved).counts['workspace-session']
    ).toBe(0)

    subtractOrcadMigrationSourceDormantState(state, moved)

    expect(state.workspaceSessionsByHostId?.[HOST_B]?.unifiedTabs?.[WORKTREE]).toHaveLength(1)
    expect(state.workspaceSession.unifiedTabs?.[`${HOST_B}|${WORKTREE}`]).toHaveLength(1)
    expect(state.worktreeMeta[`${HOST_B}|${WORKTREE}`]).toBeDefined()
    expect(state.workspaceSessionsByHostId?.['ssh:host-a']?.unifiedTabs?.[WORKTREE]).toBeUndefined()
  })

  it('subtracts selected-worktree routing by retargeting it to the destination', () => {
    const state = getDefaultPersistedState('/home/test')
    state.repos = [REPO]
    state.ui.lastActiveWorktreeId = WORKTREE
    const moved = manifest(state)
    expect(moved.payload.dormantState?.clientState?.uiRouting?.lastActiveWorktreeId).toBe(WORKTREE)

    subtractOrcadMigrationClientState(state, moved)

    expect(state.ui.lastActiveWorktreeId).toBe(`runtime:env-1|${WORKTREE}`)
  })
})
