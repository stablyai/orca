/**
 * The host (Linux) directories a committed WSL move took, as its manifest names them: each moved
 * repo and folder, and every worktree the move carried meta, lineage or a session for. A store
 * keyed by a bare file path uses them to tell a moved project's file from another in the distro.
 */
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration/orcad-migration-manifest'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../../shared/workspace-scope'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'

export function wslMoveScopeRootPaths(manifest: Pick<OrcadMigrationManifest, 'payload'>): string[] {
  const { payload } = manifest
  const dormant = payload.dormantState
  const worktreeIds = [
    ...(dormant?.worktreeMeta ?? []).map((entry) => entry.worktreeId),
    ...(dormant?.worktreeLineage ?? []).map((entry) => entry.worktreeId),
    ...Object.keys(dormant?.workspaceSession?.unifiedTabs ?? {}).map(
      normalizeWorkspaceSessionKeyToWorkspaceId
    )
  ]
  const roots = new Set<string>([
    ...payload.repositories.map((repo) => repo.path),
    ...payload.folderWorkspaces.map((folder) => folder.folderPath),
    ...worktreeIds.flatMap((id) => splitWorktreeIdForFilesystem(id)?.worktreePath ?? [])
  ])
  // The payload is already in the host's form; anything else is not a moved project's root.
  return [...roots].filter((root) => root.startsWith('/') && root !== '/')
}
