// Export and subtraction must share repo/folder host attribution or migrated rows can remain behind.
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../shared/execution-host'
import {
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHostState
} from '../../../shared/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Repo } from '../../../shared/repo-types'

export function repoBelongsToOrcadSource(repo: Repo, targetId: string): boolean {
  if (repo.connectionId === targetId) {
    return true
  }
  const host = parseExecutionHostId(getRepoExecutionHostId(repo))
  return host?.kind === 'ssh' && host.targetId === targetId
}

export function projectGroupBelongsToOrcadSource(
  group: Pick<ProjectGroup, 'connectionId' | 'executionHostId'>,
  targetId: string
): boolean {
  if (group.connectionId === targetId) {
    return true
  }
  const host = parseExecutionHostId(group.executionHostId)
  return host?.kind === 'ssh' && host.targetId === targetId
}

/** Resolve inferred folder ownership before removing repos. */
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
