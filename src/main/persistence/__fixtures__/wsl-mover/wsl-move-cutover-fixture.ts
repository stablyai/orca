/** A valid WSL move journal record whose manifest is bound to it. */
import { ORCAD_MIGRATION_MANIFEST_VERSION } from '../../../../shared/orcad-migration-manifest-validation'
import {
  wslMoveJournalKey,
  type WslMoveCutover,
  type WslMoveCutoverPhase
} from '../../../../shared/wsl-move/wsl-move-cutover'
import { computeOrcadMigrationManifestSha256 } from '../../../orcad/orcad-migration-manifest-digest'

export function wslMoveCutoverFixture(
  migrationId = 'move-1',
  phase: WslMoveCutoverPhase = 'prepared',
  extra: Partial<WslMoveCutover> = {},
  scope: { repoIds?: string[]; folderWorkspaceIds?: string[] } = {}
): WslMoveCutover {
  const repoIds = scope.repoIds ?? ['repo-1']
  const folderWorkspaceIds = scope.folderWorkspaceIds ?? []
  const unsigned = {
    version: ORCAD_MIGRATION_MANIFEST_VERSION,
    migrationId,
    createdAt: '2026-10-13T00:00:00.000Z',
    source: {
      kind: 'local-wsl' as const,
      distro: 'Ubuntu',
      scopeRepoIds: repoIds,
      scopeFolderWorkspaceIds: folderWorkspaceIds,
      generation: 1
    },
    payload: {
      repositories: repoIds.map((id) => ({
        id,
        path: `/home/dev/${id}`,
        displayName: id,
        badgeColor: '#000',
        addedAt: 0
      })),
      projectGroups: [],
      folderWorkspaces: folderWorkspaceIds.map((id) => ({
        id,
        projectGroupId: 'group',
        name: id,
        folderPath: `/srv/${id}`,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }))
    },
    destinationEnvironmentId: 'wsl:Ubuntu'
  }
  const manifest = { ...unsigned, manifestSha256: computeOrcadMigrationManifestSha256(unsigned) }
  return {
    version: 1,
    migrationId,
    phase,
    startedAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    destinationEnvironmentId: 'wsl:Ubuntu',
    destinationName: 'Ubuntu',
    journalKey: wslMoveJournalKey('Ubuntu'),
    manifestSha256: manifest.manifestSha256,
    provenExitedSessionIds: [],
    rewrittenStores: [],
    manifest,
    ...extra
  }
}
