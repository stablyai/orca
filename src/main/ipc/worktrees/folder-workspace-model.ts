import { randomUUID } from 'node:crypto'
import type { Repo } from '../../../shared/repo-types'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../../shared/workspace-statuses'
import { FOLDER_WORKSPACE_INSTANCE_SEPARATOR } from '../../../shared/worktree/id'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Worktree } from '../../../shared/worktree/types'

export function getFolderWorkspaceRootId(repo: Repo): string {
  return `${repo.id}::${repo.path}`
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

export function mergeFolderWorkspace(repo: Repo, worktreeId: string, meta: WorktreeMeta): Worktree {
  return {
    id: worktreeId,
    ...(meta.instanceId !== undefined ? { instanceId: meta.instanceId } : {}),
    repoId: repo.id,
    ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
    ...(meta.hostId !== undefined ? { hostId: meta.hostId } : {}),
    ...(meta.projectHostSetupId !== undefined
      ? { projectHostSetupId: meta.projectHostSetupId }
      : {}),
    path: repo.path,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: worktreeId === getFolderWorkspaceRootId(repo),
    displayName: meta.displayName || repo.displayName,
    comment: meta.comment || '',
    linkedIssue: meta.linkedIssue ?? null,
    linkedPR: meta.linkedPR ?? null,
    linkedLinearIssue: meta.linkedLinearIssue ?? null,
    linkedLinearIssueWorkspaceId: meta.linkedLinearIssueWorkspaceId ?? null,
    linkedLinearIssueOrganizationUrlKey: meta.linkedLinearIssueOrganizationUrlKey ?? null,
    linkedGitLabMR: meta.linkedGitLabMR ?? null,
    linkedGitLabIssue: meta.linkedGitLabIssue ?? null,
    linkedBitbucketPR: meta.linkedBitbucketPR ?? null,
    linkedAzureDevOpsPR: meta.linkedAzureDevOpsPR ?? null,
    linkedGiteaPR: meta.linkedGiteaPR ?? null,
    linkedWorkItem: meta.linkedWorkItem ?? null,
    linkedTaskSourceContext: meta.linkedTaskSourceContext ?? null,
    isArchived: meta.isArchived ?? false,
    isUnread: meta.isUnread ?? false,
    isPinned: meta.isPinned ?? false,
    sortOrder: meta.sortOrder ?? 0,
    ...(meta.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
    lastActivityAt: meta.lastActivityAt ?? 0,
    ...(meta.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
    ...(meta.createdWithAgent !== undefined ? { createdWithAgent: meta.createdWithAgent } : {}),
    ...(meta.automationProvenance !== undefined
      ? { automationProvenance: meta.automationProvenance }
      : {}),
    ...(meta.cliProvenance !== undefined ? { cliProvenance: meta.cliProvenance } : {}),
    ...(meta.priorWorktreeIds !== undefined ? { priorWorktreeIds: meta.priorWorktreeIds } : {}),
    workspaceStatus: meta.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
    diffComments: meta.diffComments,
    mobileDiffReview: meta.mobileDiffReview
  }
}
