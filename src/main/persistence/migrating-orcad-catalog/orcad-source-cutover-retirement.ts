import { syncProjectHostSetupCompatibilityState } from '../loading-store/repo-lifecycle-operations'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import type { OrcadSourceCutoverContext } from './orcad-source-cutover-context'

export function retireSourceCatalogRows(
  context: OrcadSourceCutoverContext,
  manifest: OrcadMigrationManifest
): void {
  retireOrcadSourceCatalogState(context.runtime.state, manifest)
  syncProjectHostSetupCompatibilityState(context.repos)
}

export function retireOrcadSourceCatalogState(
  state: StoreRuntimeState['state'],
  manifest: OrcadMigrationManifest
): void {
  const repoIds = new Set(manifest.payload.repositories.map((repo) => repo.id))
  const folderIds = new Set(manifest.payload.folderWorkspaces.map((workspace) => workspace.id))
  const groupIds = new Set(manifest.payload.projectGroups.map((group) => group.id))
  const groupConnectionById = new Map(
    state.projectGroups.map((group) => [group.id, group.connectionId])
  )
  state.repos = state.repos.filter(
    (repo) => !(repoIds.has(repo.id) && repo.connectionId === manifest.source.sshTargetId)
  )
  state.folderWorkspaces = state.folderWorkspaces.filter(
    (workspace) =>
      !(
        folderIds.has(workspace.id) &&
        (workspace.connectionId ?? groupConnectionById.get(workspace.projectGroupId) ?? null) ===
          manifest.source.sshTargetId
      )
  )
  removeUnreferencedSourceGroups(state, groupIds, manifest.source.sshTargetId)
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
