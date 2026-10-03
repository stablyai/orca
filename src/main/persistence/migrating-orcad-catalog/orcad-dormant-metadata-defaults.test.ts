import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { fillDefaultWorktreeMetaFields } from '../../../shared/worktree/meta-persisted-defaults'
import {
  assertCommittedOrcadMigrationDormantState,
  prepareOrcadMigrationDormantState
} from './orcad-dormant-state-records'

const KEY = 'repo::/srv/worktree'

function fixture() {
  const state = getDefaultPersistedState('/tmp/orcad-metadata-defaults')
  const meta = {
    displayName: 'Workspace',
    comment: 'preserve',
    isUnread: true,
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1
  }
  const manifest: OrcadMigrationManifest = {
    version: 1,
    migrationId: 'migration',
    createdAt: '2026-09-06T00:00:00.000Z',
    source: { sshTargetId: 'ssh', sshTargetGeneration: 1, targetLabel: 'host' },
    manifestSha256: 'unused-by-dormant-validator',
    payload: {
      repositories: [],
      projectGroups: [],
      folderWorkspaces: [],
      dormantState: {
        version: 1,
        worktreeMeta: [{ sourceKey: KEY, worktreeId: KEY, meta }],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: []
      }
    }
  }
  state.worktreeMeta[KEY] = { ...meta }
  fillDefaultWorktreeMetaFields(state.worktreeMeta[KEY])
  return { state, manifest }
}

describe('migration metadata default equivalence', () => {
  it('accepts load-materialized defaults without changing the manifest or state', () => {
    const { state, manifest } = fixture()
    const before = structuredClone({ state, manifest })
    expect(prepareOrcadMigrationDormantState(manifest, state).newWorktreeMeta).toEqual([])
    expect(() => assertCommittedOrcadMigrationDormantState(manifest, state)).not.toThrow()
    expect({ state, manifest }).toEqual(before)
  })

  it.each(['isPinned', 'isArchived'] as const)('still refuses a changed %s value', (field) => {
    const { state, manifest } = fixture()
    state.worktreeMeta[KEY][field] = true
    expect(() => prepareOrcadMigrationDormantState(manifest, state)).toThrow(
      `orcad_migration_dormant_id_conflict:worktree_meta:${KEY}`
    )
    expect(() => assertCommittedOrcadMigrationDormantState(manifest, state)).toThrow(
      `orcad_migration_dormant_id_conflict:receipt_dormant_mismatch:worktree_meta:${KEY}`
    )
  })
})
