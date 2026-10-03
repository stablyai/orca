/**
 * Which catalog rows a migrating SSH target owns, answered the way the app attributes them.
 *
 * A repo names its host by the legacy `connectionId` or by `executionHostId: 'ssh:<target>'`; a
 * folder workspace by its own or its group's connection, or by the repos inside its folder, which
 * main matches with `isPathInsideOrEqual` (drive letters and case folded on Windows paths). Export
 * and retirement must use one rule, or a row exported by one is left behind by the other.
 */
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import {
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHostState
} from '../../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { Repo } from '../../../shared/repo-types'

export function repoBelongsToOrcadSource(repo: Repo, targetId: string): boolean {
  if (repo.connectionId === targetId) {
    return true
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'ssh' && host.targetId === targetId
}

/** Folder workspace ids the target owns in `state`; read before any of its repos are removed. */
export function orcadSourceFolderWorkspaceIds(
  state: FolderWorkspaceHostState,
  targetId: string
): Set<string> {
  const groupConnectionById = new Map(
    state.projectGroups.map((group) => [group.id, group.connectionId])
  )
  const owned = (workspace: FolderWorkspace): boolean => {
    if (
      (workspace.connectionId ?? groupConnectionById.get(workspace.projectGroupId) ?? null) ===
      targetId
    ) {
      return true
    }
    const host = resolveFolderWorkspaceHost(state, workspace.id)
    return host.kind === 'ssh' && host.targetId === targetId
  }
  return new Set(state.folderWorkspaces.filter(owned).map((workspace) => workspace.id))
}
