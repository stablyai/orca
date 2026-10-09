import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import {
  ORCAD_MIGRATION_MANIFEST_VERSION,
  type OrcadMigrationManifest
} from '../../../shared/orcad-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { Repo } from '../../../shared/repo-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { DORMANT_AUTOMATION } from '../../persistence-orcad-migration-catalog-fixture'
import { subtractOrcadMigrationClientState } from './orcad-source-client-subtraction'
import { collectOrcadMigrationSourceDormantState } from './orcad-source-dormant-state'
import { subtractOrcadMigrationSourceDormantState } from './orcad-source-dormant-subtraction'
import { createOrcadMigrationSourceScope } from './orcad-source-scope'
import { inspectOrcadSourceWorktreeMetadata } from './orcad-source-worktree-metadata'

// Host A converts; host B registered the same repository id. Every key below is legacy, unqualified.
const REPO_A: Repo = {
  id: 'repo-1',
  path: '/srv/repo',
  displayName: 'Repository',
  badgeColor: '#737373',
  addedAt: 1,
  connectionId: 'host-a'
}
const REPO_B: Repo = { ...REPO_A, connectionId: 'host-b' }
const WORKTREE = `${REPO_A.id}::/srv/repo`
const SOURCE = { sshTargetId: 'host-a', sshTargetGeneration: 3, targetLabel: 'A' }

function meta(hostId?: WorktreeMeta['hostId']): WorktreeMeta {
  return {
    displayName: 'worktree',
    comment: '',
    isUnread: false,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    ...(hostId ? { hostId } : {})
  }
}

function manifest(state: PersistedState): OrcadMigrationManifest {
  const payload = { repositories: [REPO_A], projectGroups: [], folderWorkspaces: [] }
  const dormant = collectOrcadMigrationSourceDormantState(state, SOURCE, payload, undefined, 'e1')
  return {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId: 'migration-1',
    createdAt: '2026-10-05T12:00:00.000Z',
    source: SOURCE,
    payload: { ...payload, dormantState: dormant.payload },
    destinationEnvironmentId: 'e1',
    manifestSha256: 'a'.repeat(64)
  }
}

/** Host B's state in every store that is not a session partition, keyed by legacy repo ids. */
function hostBLegacyState(): PersistedState {
  const state = getDefaultPersistedState('/home/test')
  state.repos = [REPO_A, REPO_B]
  state.worktreeMeta[WORKTREE] = meta('ssh:host-b')
  state.worktreeMeta[`${REPO_A.id}::/srv/repo-unmarked`] = meta()
  state.automations = [
    {
      ...DORMANT_AUTOMATION,
      id: 'automation-b',
      runContext: { ...DORMANT_AUTOMATION.runContext!, hostId: 'ssh:host-b', repoId: REPO_A.id },
      projectId: REPO_A.id,
      executionTargetType: 'ssh',
      executionTargetId: 'host-b',
      executionTargetGeneration: SOURCE.sshTargetGeneration
    }
  ]
  state.worktreeLineageById[WORKTREE] = {
    worktreeId: WORKTREE,
    worktreeInstanceId: 'i-1',
    parentWorktreeId: `${REPO_A.id}::/srv/parent`,
    parentWorktreeInstanceId: 'i-0',
    origin: 'manual',
    capture: { source: 'manual-action', confidence: 'explicit' },
    createdAt: 1
  }
  state.sparsePresetsByRepo[REPO_A.id] = [
    {
      id: 'preset-b',
      repoId: REPO_A.id,
      name: 'B',
      directories: ['src'],
      createdAt: 1,
      updatedAt: 1
    }
  ]
  state.ui.lastActiveRepoId = REPO_A.id
  state.ui.lastActiveWorktreeId = WORKTREE
  state.ui.filterRepoIds = [REPO_A.id]
  state.ui.showDotfilesByWorktree = { [WORKTREE]: true }
  return state
}

describe('legacy unqualified keys for a repo id two hosts share', () => {
  it('cannot attribute them to the converting host', () => {
    const state = hostBLegacyState()
    const scope = createOrcadMigrationSourceScope({
      source: SOURCE,
      catalog: { repositories: [REPO_A], projectGroups: [], folderWorkspaces: [] },
      repos: state.repos
    })
    expect([...scope.sharedRepoIds]).toEqual([REPO_A.id])
    expect(inspectOrcadSourceWorktreeMetadata(state, scope)).toEqual({ rows: [], blockedCount: 0 })
  })

  it("never moves, counts or retires host B's rows", () => {
    const state = hostBLegacyState()
    const before = structuredClone(state)
    const moved = manifest(state)
    const dormant = moved.payload.dormantState
    expect(dormant?.worktreeMeta ?? []).toEqual([])
    expect(dormant?.worktreeLineage ?? []).toEqual([])
    expect(dormant?.sparsePresets ?? []).toEqual([])
    expect(dormant?.automations ?? []).toEqual([])
    expect(dormant?.clientState?.uiRouting ?? {}).toEqual({})
    expect(
      Object.values(
        collectOrcadMigrationSourceDormantState(state, SOURCE, moved.payload, undefined, 'e1')
          .blockedCounts
      ).every((count) => count === 0)
    ).toBe(true)

    subtractOrcadMigrationSourceDormantState(state, moved)
    subtractOrcadMigrationClientState(state, moved)

    expect(state.worktreeMeta).toEqual(before.worktreeMeta)
    expect(state.automations).toEqual(before.automations)
    expect(state.worktreeLineageById).toEqual(before.worktreeLineageById)
    expect(state.sparsePresetsByRepo).toEqual(before.sparsePresetsByRepo)
    expect(state.ui.lastActiveRepoId).toBe(REPO_A.id)
    expect(state.ui.filterRepoIds).toEqual([REPO_A.id])
    expect(state.ui.showDotfilesByWorktree).toEqual({ [WORKTREE]: true })
  })
})

describe('an identity alias whose metadata is gone (the B4 profile shape)', () => {
  it('is nothing to move, and retirement drops it', () => {
    const state = getDefaultPersistedState('/home/test')
    state.repos = [REPO_A]
    // As saved on B4: the legacy row carries the metadata; the alias names an identity that is gone.
    state.worktreeMeta[WORKTREE] = { ...meta('ssh:host-a'), instanceId: 'instance-1' }
    const alias = `ssh:host-a|${WORKTREE}`
    state.worktreeIdentityAliases = { [alias]: ['wt2:ssh%3Ahost-a:instance-1'] }
    state.worktreeMetaByIdentity = {}
    const scope = createOrcadMigrationSourceScope({
      source: SOURCE,
      catalog: { repositories: [REPO_A], projectGroups: [], folderWorkspaces: [] },
      repos: state.repos
    })
    const inspection = inspectOrcadSourceWorktreeMetadata(state, scope)
    expect(inspection.blockedCount).toBe(0)
    expect(inspection.rows.map((row) => row.sourceKey)).toEqual([WORKTREE])

    // A dangling alias with no legacy row beside it is dropped too.
    state.worktreeIdentityAliases[`ssh:host-a|${REPO_A.id}::/srv/gone`] = ['wt2:ssh%3Ahost-a:x']
    expect(inspectOrcadSourceWorktreeMetadata(state, scope).blockedCount).toBe(0)
    subtractOrcadMigrationSourceDormantState(state, manifest(state))
    expect(state.worktreeIdentityAliases).toEqual({})
    expect(state.worktreeMeta).toEqual({})
  })
})
