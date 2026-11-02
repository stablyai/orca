// Delta-view copies only: remove still-owned manifest rows; retain groups referenced elsewhere.
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { requireOrcadMigrationSshSource } from '../../../shared/orcad-migration/orcad-migration-source-kind'
import { orcadSourceFolderWorkspaceIds, repoBelongsToOrcadSource } from './orcad-source-ownership'

export function subtractOrcadSourceCatalogState(
  state: StoreRuntimeState['state'],
  manifest: OrcadMigrationManifest
): void {
  const repoIds = new Set(manifest.payload.repositories.map((repo) => repo.id))
  const folderIds = new Set(manifest.payload.folderWorkspaces.map((workspace) => workspace.id))
  const groupIds = new Set(manifest.payload.projectGroups.map((group) => group.id))
  const targetId = requireOrcadMigrationSshSource(manifest.source).sshTargetId
  // Resolve inferred folder ownership before deleting its repos.
  const ownedFolderIds = orcadSourceFolderWorkspaceIds(state, targetId)
  state.repos = state.repos.filter(
    (repo) => !(repoIds.has(repo.id) && repoBelongsToOrcadSource(repo, targetId))
  )
  state.folderWorkspaces = state.folderWorkspaces.filter(
    (workspace) => !(folderIds.has(workspace.id) && ownedFolderIds.has(workspace.id))
  )
  removeUnreferencedSourceGroups(state, groupIds, targetId)
}

function removeUnreferencedSourceGroups(
  state: StoreRuntimeState['state'],
  candidateIds: ReadonlySet<string>,
  targetId: string
): void {
  let removed = true
  while (removed) {
    removed = false
    const referencedIds = new Set([
      ...state.repos.flatMap((repo) => (repo.projectGroupId ? [repo.projectGroupId] : [])),
      ...state.folderWorkspaces.map((workspace) => workspace.projectGroupId),
      ...state.projectGroups.flatMap((group) => (group.parentGroupId ? [group.parentGroupId] : []))
    ])
    const next = state.projectGroups.filter((group) => {
      const shouldRemove =
        candidateIds.has(group.id) &&
        group.connectionId === targetId &&
        !referencedIds.has(group.id)
      removed ||= shouldRemove
      return !shouldRemove
    })
    state.projectGroups = next
  }
}
