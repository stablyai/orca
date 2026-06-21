import { basename } from 'path'
import type { GitWorktreeInfo, Worktree, WorktreeMeta } from '../../shared/types'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import { getLinkedWorkItemMetadata } from './worktree-linked-work-item-metadata'

/**
 * Merge raw git worktree info with persisted user metadata into a full Worktree.
 */
export function mergeWorktree(
  repoId: string,
  git: GitWorktreeInfo,
  meta: WorktreeMeta | undefined,
  defaultDisplayName?: string
): Worktree {
  const branchShort = git.branch.replace(/^refs\/heads\//, '')
  return {
    id: `${repoId}::${git.path}`,
    ...(meta?.instanceId !== undefined ? { instanceId: meta.instanceId } : {}),
    repoId,
    ...(meta?.projectId !== undefined ? { projectId: meta.projectId } : {}),
    ...(meta?.hostId !== undefined ? { hostId: meta.hostId } : {}),
    ...(meta?.projectHostSetupId !== undefined
      ? { projectHostSetupId: meta.projectHostSetupId }
      : {}),
    path: git.path,
    head: git.head,
    branch: git.branch,
    isBare: git.isBare,
    ...(git.isSparse === true ? { isSparse: true } : {}),
    isMainWorktree: git.isMainWorktree,
    displayName: meta?.displayName || branchShort || defaultDisplayName || basename(git.path),
    comment: meta?.comment || '',
    linkedIssue: meta?.linkedIssue ?? null,
    linkedPR: meta?.linkedPR ?? null,
    linkedLinearIssue: meta?.linkedLinearIssue ?? null,
    linkedLinearIssueWorkspaceId: meta?.linkedLinearIssueWorkspaceId ?? null,
    linkedLinearIssueOrganizationUrlKey: meta?.linkedLinearIssueOrganizationUrlKey ?? null,
    ...getLinkedWorkItemMetadata(meta),
    isArchived: meta?.isArchived ?? false,
    isUnread: meta?.isUnread ?? false,
    isPinned: meta?.isPinned ?? false,
    sortOrder: meta?.sortOrder ?? 0,
    ...(meta?.manualOrder !== undefined ? { manualOrder: meta.manualOrder } : {}),
    lastActivityAt: meta?.lastActivityAt ?? 0,
    ...(meta?.createdAt !== undefined ? { createdAt: meta.createdAt } : {}),
    ...(meta?.createdWithAgent !== undefined ? { createdWithAgent: meta.createdWithAgent } : {}),
    ...(meta?.automationProvenance !== undefined
      ? { automationProvenance: meta.automationProvenance }
      : {}),
    ...(meta?.pendingFirstAgentMessageRename !== undefined
      ? { pendingFirstAgentMessageRename: meta.pendingFirstAgentMessageRename }
      : {}),
    ...(meta?.firstAgentMessageRenameError !== undefined
      ? { firstAgentMessageRenameError: meta.firstAgentMessageRenameError }
      : {}),
    ...(git.isSparse === true
      ? {
          sparseDirectories: meta?.sparseDirectories,
          sparseBaseRef: meta?.sparseBaseRef,
          sparsePresetId: meta?.sparsePresetId
        }
      : {}),
    ...(meta?.baseRef !== undefined ? { baseRef: meta.baseRef } : {}),
    ...(meta?.pushTarget !== undefined ? { pushTarget: meta.pushTarget } : {}),
    ...(meta?.priorWorktreeIds !== undefined ? { priorWorktreeIds: meta.priorWorktreeIds } : {}),
    workspaceStatus: meta?.workspaceStatus ?? DEFAULT_WORKSPACE_STATUS_ID,
    // Why: diff comments are persisted on WorktreeMeta and forwarded verbatim
    // so the renderer store mirrors on-disk state.
    diffComments: meta?.diffComments,
    mobileDiffReview: meta?.mobileDiffReview
  }
}
