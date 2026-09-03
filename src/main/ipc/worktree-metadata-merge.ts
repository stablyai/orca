import { basename } from 'node:path'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitWorktreeInfo, Worktree } from '../../shared/worktree/types'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../shared/workspace-statuses'
import { getLinkedWorkItemMetadata } from './worktree-linked-work-item-metadata'
import { normalizeWorkspaceCreatorProvenance } from '../../shared/workspace-creator-provenance'
import { createWorktreeIdentity } from '../../shared/worktree/identity'

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
  const creatorProvenance = normalizeWorkspaceCreatorProvenance(meta?.creatorProvenance)
  const worktreeId = `${repoId}::${git.path}`
  const automaticDisplayName = branchShort || defaultDisplayName || basename(git.path)
  // CLI-created labels predate displayNameIsPinned but are still explicit names.
  const legacyCliDisplayNameIsPinned =
    meta?.displayNameIsPinned === undefined && meta?.cliProvenance?.kind === 'created-by-cli'
  return {
    id: worktreeId,
    ...(meta?.instanceId && meta.hostId
      ? {
          identity: createWorktreeIdentity({
            worktreeId,
            executionHostId: meta.hostId,
            instanceId: meta.instanceId
          })
        }
      : {}),
    ...(meta?.instanceId !== undefined ? { instanceId: meta.instanceId } : {}),
    repoId,
    ...(meta?.projectId !== undefined ? { projectId: meta.projectId } : {}),
    ...(meta?.hostId !== undefined ? { hostId: meta.hostId } : {}),
    ...(meta?.projectHostSetupId !== undefined
      ? { projectHostSetupId: meta.projectHostSetupId }
      : {}),
    ...(meta?.ephemeralVmCheckoutMode !== undefined
      ? { ephemeralVmCheckoutMode: meta.ephemeralVmCheckoutMode }
      : {}),
    ...(creatorProvenance ? { creatorProvenance } : {}),
    path: git.path,
    head: git.head,
    branch: git.branch,
    isBare: git.isBare,
    ...(git.isSparse === true ? { isSparse: true } : {}),
    isMainWorktree: git.isMainWorktree,
    // Automatic labels follow the live branch; persisted values are only authoritative when pinned.
    displayName:
      meta?.displayNameIsPinned === false
        ? automaticDisplayName
        : meta?.displayName || automaticDisplayName,
    displayNameMode:
      meta?.displayNameIsPinned === true || legacyCliDisplayNameIsPinned
        ? 'fixed'
        : meta?.displayNameIsPinned === false
          ? 'automatic'
          : meta?.displayName && meta.displayName.trim() !== branchShort
            ? 'fixed'
            : 'automatic',
    comment: meta?.comment || '',
    linkedIssue: meta?.linkedIssue ?? null,
    linkedPR: meta?.linkedPR ?? null,
    ...(meta?.suppressedGitHubPR !== undefined
      ? { suppressedGitHubPR: meta.suppressedGitHubPR }
      : {}),
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
    ...(meta?.cliProvenance !== undefined ? { cliProvenance: meta.cliProvenance } : {}),
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
