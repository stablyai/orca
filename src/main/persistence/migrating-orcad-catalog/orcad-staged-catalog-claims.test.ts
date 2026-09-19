import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { assertOrcadMigrationStagedCatalogClaims } from './orcad-staged-catalog-claims'

const LEAF = '11111111-1111-4111-8111-111111111111'

function manifest(id: string): OrcadMigrationManifest {
  return {
    version: 1,
    migrationId: id,
    manifestSha256: id.repeat(64),
    createdAt: '2026-09-06T00:00:00.000Z',
    source: { sshTargetId: id, sshTargetGeneration: 1, targetLabel: id },
    payload: {
      repositories: [{ id, path: `/srv/${id}`, displayName: id, badgeColor: '', addedAt: 1 }],
      projectGroups: [],
      folderWorkspaces: [],
      dormantState: {
        version: 1,
        worktreeMeta: [],
        worktreeLineage: [],
        workspaceLineage: [],
        sparsePresets: [],
        retiredWorktreeNames: [],
        retiredWorktreeNamespaces: [],
        workspaceSession: getDefaultWorkspaceSession()
      }
    }
  }
}

function assertClaims(next: OrcadMigrationManifest, prior: OrcadMigrationManifest) {
  return assertOrcadMigrationStagedCatalogClaims(next, [
    {
      version: 1,
      manifest: prior,
      stagedAt: prior.createdAt
    }
  ])
}

describe('staged migration catalog claims', () => {
  it('allows disjoint stages and exact same-transaction retries without mutation', () => {
    const first = manifest('a')
    const second = manifest('b')
    const before = structuredClone({ first, second })
    expect(() => assertClaims(second, first)).not.toThrow()
    expect(() => assertClaims(structuredClone(first), first)).not.toThrow()
    expect({ first, second }).toEqual(before)
  })

  it('rejects a reused transaction ID with a different digest', () => {
    const first = manifest('a')
    expect(() => assertClaims({ ...first, manifestSha256: 'b'.repeat(64) }, first)).toThrow(
      'orcad_migration_id_reused_with_different_manifest'
    )
  })

  it('reserves the repository path even when another migration changes its ID', () => {
    const first = manifest('a')
    const second = manifest('b')
    second.payload.repositories[0].path = first.payload.repositories[0].path
    expect(() => assertClaims(second, first)).toThrow(
      'orcad_migration_staged_claim_conflict:repository-path:/srv/a'
    )
  })

  it('reserves folder identity without treating a shared folder path as identity', () => {
    const first = manifest('a')
    const second = manifest('b')
    const folder = {
      id: 'folder',
      projectGroupId: 'group',
      name: 'Folder',
      folderPath: '/srv/folder',
      connectionId: null,
      linkedTask: null,
      linkedTaskSourceContext: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 1,
      lastActivityAt: 1,
      createdAt: 1,
      updatedAt: 1
    }
    first.payload.folderWorkspaces = [folder]
    second.payload.folderWorkspaces = [{ ...folder, id: 'distinct-folder' }]
    expect(() => assertClaims(second, first)).not.toThrow()
    second.payload.folderWorkspaces = [{ ...folder }]
    expect(() => assertClaims(second, first)).toThrow(
      'orcad_migration_staged_claim_conflict:folder-workspace:folder'
    )
  })

  it.each(['topology', 'scrollback'] as const)(
    'reserves a stable pane claimed by another tab through %s',
    (claim) => {
      const first = manifest('a')
      const second = manifest('b')
      const firstSession = first.payload.dormantState!.workspaceSession!
      firstSession.terminalLayoutsByTabId.first = {
        root: claim === 'topology' ? { type: 'leaf', leafId: LEAF } : null,
        activeLeafId: null,
        expandedLeafId: null,
        ...(claim === 'scrollback' ? { scrollbackRefsByLeafId: { [LEAF]: 'snapshot' } } : {})
      }
      second.payload.dormantState!.workspaceSession!.terminalLayoutsByTabId.second = {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: null,
        expandedLeafId: null
      }
      const before = structuredClone({ first, second })
      expect(() => assertClaims(second, first)).toThrow(
        `orcad_migration_staged_claim_conflict:session:terminal-leaf:${LEAF}`
      )
      expect({ first, second }).toEqual(before)
    }
  )

  it('reserves an empty tab layout before it contains any pane', () => {
    const first = manifest('a')
    const second = manifest('b')
    for (const entry of [first, second]) {
      entry.payload.dormantState!.workspaceSession!.terminalLayoutsByTabId.tab = {
        root: null,
        activeLeafId: null,
        expandedLeafId: null
      }
    }
    expect(() => assertClaims(second, first)).toThrow(
      'orcad_migration_staged_claim_conflict:session:terminal-layout:tab'
    )
  })
})
