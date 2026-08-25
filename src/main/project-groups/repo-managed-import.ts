import { getRuntimePathBasename, normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup, ProjectGroupImportResult } from '../../shared/project-group-types'
import {
  findMainFolderWorkspace,
  REPO_MANAGED_CREATED_FROM
} from '../../shared/repo-managed-project'

type RepoManagedImportStore = {
  getProjectGroups: () => ProjectGroup[]
  createProjectGroup: (input: {
    name: string
    parentPath?: string | null
    connectionId?: string | null
    parentGroupId?: string | null
    createdFrom: ProjectGroup['createdFrom']
  }) => ProjectGroup
  getFolderWorkspaces: () => FolderWorkspace[]
  createFolderWorkspace: (input: {
    projectGroupId: string
    name?: string
    folderPath?: string | null
    connectionId?: string | null
  }) => FolderWorkspace
}

function sameHostPath(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  if (!left || !right) {
    return false
  }
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

export function findExistingFolderBackedGroup(args: {
  groups: readonly ProjectGroup[]
  parentPath: string
  connectionId?: string | null
}): ProjectGroup | undefined {
  const connectionId = args.connectionId ?? null
  return args.groups.find(
    (group) =>
      group.parentGroupId === null &&
      (group.connectionId ?? null) === connectionId &&
      sameHostPath(group.parentPath, args.parentPath)
  )
}

export function importRepoManagedProject(args: {
  store: RepoManagedImportStore
  parentPath: string
  groupName?: string
  connectionId?: string | null
}): ProjectGroupImportResult {
  const parentPath = args.parentPath.trim()
  const connectionId = args.connectionId ?? null
  const existingGroup = findExistingFolderBackedGroup({
    groups: args.store.getProjectGroups(),
    parentPath,
    connectionId
  })
  const group =
    existingGroup ??
    args.store.createProjectGroup({
      name: args.groupName?.trim() || getRuntimePathBasename(parentPath) || 'Repo project',
      parentPath,
      connectionId,
      parentGroupId: null,
      createdFrom: REPO_MANAGED_CREATED_FROM
    })
  const alreadyKnown = Boolean(findMainFolderWorkspace(args.store.getFolderWorkspaces(), group))
  if (!alreadyKnown) {
    args.store.createFolderWorkspace({
      projectGroupId: group.id,
      name: group.name,
      folderPath: parentPath,
      connectionId
    })
  }
  return {
    group,
    projects: [
      {
        path: parentPath,
        status: alreadyKnown ? 'already-known' : 'imported'
      }
    ],
    importedCount: alreadyKnown ? 0 : 1,
    alreadyKnownCount: alreadyKnown ? 1 : 0,
    failedCount: 0
  }
}
