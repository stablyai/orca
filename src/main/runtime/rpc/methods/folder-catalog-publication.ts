import { z } from 'zod'
import {
  resolveDeclaredFolderScopeOwner,
  resolveFolderWorkspaceOwner,
  resolveProjectGroupOwner
} from '../../../../shared/folder-workspace-owner-resolution'
import type { FolderWorkspace, ProjectGroup } from '../../../../shared/types'

export const FolderCatalogListParams = z
  .object({ ownerQualified: z.literal(true).optional() })
  .nullish()

export function projectFolderCatalogForClient<T extends { id: string }>(
  catalog: readonly T[],
  ownerQualified: boolean
): T[] {
  if (ownerQualified) {
    return [...catalog]
  }
  const counts = new Map<string, number>()
  for (const entry of catalog) {
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1)
  }
  return catalog.filter((entry) => counts.get(entry.id) === 1)
}

export function projectProjectGroupCatalogForClient(
  groups: readonly ProjectGroup[],
  ownerQualified: boolean
): ProjectGroup[] {
  if (ownerQualified) {
    return [...groups]
  }
  return projectFolderCatalogForClient(groups, false).filter(
    (group) => resolveDeclaredFolderScopeOwner(group).status !== 'invalid'
  )
}

export function projectFolderWorkspaceCatalogForClient(
  workspaces: readonly FolderWorkspace[],
  groups: readonly ProjectGroup[],
  ownerQualified: boolean
): FolderWorkspace[] {
  if (ownerQualified) {
    return [...workspaces]
  }
  const legacyGroups = projectProjectGroupCatalogForClient(groups, false)
  const groupById = new Map(legacyGroups.map((group) => [group.id, group]))
  return projectFolderCatalogForClient(workspaces, false).filter((workspace) => {
    const group = groupById.get(workspace.projectGroupId)
    if (!group) {
      return false
    }
    const workspaceOwner = resolveFolderWorkspaceOwner(workspace, groups)
    if (workspaceOwner.status !== 'owned') {
      return false
    }
    if (workspace.connectionId !== undefined) {
      return true
    }
    const groupOwner = resolveProjectGroupOwner(group)
    return (
      groupOwner.status === 'owned' && groupOwner.executionHostId === workspaceOwner.executionHostId
    )
  })
}
