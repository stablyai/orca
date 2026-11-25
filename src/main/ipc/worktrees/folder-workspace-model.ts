import { randomUUID } from 'node:crypto'
import type { Repo } from '../../../shared/repository/repo-types'
import {
  FOLDER_WORKSPACE_INSTANCE_SEPARATOR,
  getRepoMainWorktreeId
} from '../../../shared/worktree/id'

export function getFolderWorkspaceRootId(repo: Repo): string {
  return getRepoMainWorktreeId(repo)
}

export function getFolderWorkspaceInstanceId(repo: Repo, instanceId: string): string {
  return `${getFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}${instanceId}`
}

export function getFolderWorkspaceInstanceIdentity(repo: Repo, worktreeId: string): string {
  const prefix = `${getFolderWorkspaceRootId(repo)}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`
  return worktreeId.startsWith(prefix) ? worktreeId.slice(prefix.length) : randomUUID()
}

export function isFolderWorkspaceIdForRepo(repo: Repo, worktreeId: string): boolean {
  const rootId = getFolderWorkspaceRootId(repo)
  return (
    worktreeId === rootId ||
    worktreeId.startsWith(`${rootId}${FOLDER_WORKSPACE_INSTANCE_SEPARATOR}`)
  )
}

export { mergeFolderRepoWorkspace as mergeFolderWorkspace } from '../../../shared/folder-workspaces/folder-repo-workspace-row'
