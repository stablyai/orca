import type { ExecutionHostId } from '../../shared/execution-host'
import {
  resolveFolderWorkspaceOwner,
  resolveProjectGroupOwner,
  type DeclaredFolderScopeOwner
} from '../../shared/folder-workspace-owner-resolution'
import type { FolderWorkspace, ProjectGroup } from '../../shared/types'

function findFolderScopeForExecutionHost<T>(args: {
  candidates: readonly T[]
  executionHostId: ExecutionHostId
  resolveOwner: (candidate: T) => DeclaredFolderScopeOwner
}): T | undefined {
  const owners = args.candidates.map(args.resolveOwner)
  if (owners.some((owner) => owner.status === 'invalid')) {
    return undefined
  }
  if (owners.some((owner) => owner.status === 'unknown')) {
    return args.candidates.length === 1 && owners[0]?.status === 'unknown'
      ? args.candidates[0]
      : undefined
  }
  const matches = args.candidates.filter((_, index) => {
    const owner = owners[index]
    return owner?.status === 'owned' && owner.executionHostId === args.executionHostId
  })
  return matches.length === 1 ? matches[0] : undefined
}

export function findProjectGroupPathStatusScope(args: {
  groups: readonly ProjectGroup[]
  projectGroupId: string
  executionHostId?: ExecutionHostId
}): ProjectGroup | undefined {
  const candidates = args.groups.filter((group) => group.id === args.projectGroupId)
  return args.executionHostId
    ? findFolderScopeForExecutionHost({
        candidates,
        executionHostId: args.executionHostId,
        resolveOwner: resolveProjectGroupOwner
      })
    : candidates.length === 1
      ? candidates[0]
      : undefined
}

export function findFolderWorkspacePathStatusScope(args: {
  workspaces: readonly FolderWorkspace[]
  groups: readonly ProjectGroup[]
  folderWorkspaceId: string
  executionHostId?: ExecutionHostId
}): FolderWorkspace | undefined {
  const candidates = args.workspaces.filter((workspace) => workspace.id === args.folderWorkspaceId)
  return args.executionHostId
    ? findFolderScopeForExecutionHost({
        candidates,
        executionHostId: args.executionHostId,
        resolveOwner: (workspace) => resolveFolderWorkspaceOwner(workspace, args.groups)
      })
    : candidates.length === 1
      ? candidates[0]
      : undefined
}
