import type { Repo } from '../../../../shared/repository/repo-types'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoMainWorktreeId
} from '../../../../shared/worktree/id'

export function getRuntimeFolderWorkspaceRootId(repo: Repo): string {
  return getRepoMainWorktreeId(repo)
}

export function getRuntimeFolderWorkspaceInstanceId(repo: Repo, instanceId: string): string {
  return `${getRuntimeFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${instanceId}`
}

export function isRuntimeFolderWorkspaceIdForRepo(repo: Repo, worktreeId: string): boolean {
  const rootId = getRuntimeFolderWorkspaceRootId(repo)
  return (
    worktreeId === rootId ||
    worktreeId.startsWith(`${rootId}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`)
  )
}

export { mergeFolderRepoWorkspace as mergeRuntimeFolderWorkspace } from '../../../../shared/folder-workspaces/folder-repo-workspace-row'
