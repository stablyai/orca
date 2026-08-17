import type { ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { resolveFolderWorkspaceCatalogOwnerHostId } from '../../../shared/folder-workspaces'

export function sortFolderWorkspaces(workspaces: readonly FolderWorkspace[]): FolderWorkspace[] {
  return [...workspaces].sort(
    (left, right) => right.sortOrder - left.sortOrder || left.name.localeCompare(right.name)
  )
}

export function findFolderWorkspaceForOwner(
  workspaces: readonly FolderWorkspace[],
  projectGroups: readonly ProjectGroup[],
  id: string,
  ownerHostId?: ExecutionHostId
): FolderWorkspace | undefined {
  const matches = workspaces.filter(
    (workspace) =>
      workspace.id === id &&
      (!ownerHostId ||
        resolveFolderWorkspaceCatalogOwnerHostId(workspace, projectGroups) === ownerHostId)
  )
  return matches.length === 1 ? matches[0] : undefined
}
