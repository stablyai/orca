import { WorktreeSet } from '../../../../shared/rpc-contract/worktree-params'
import { displayNameUpdatePinsLabel } from '../../../../shared/worktree/display-name-provenance'
import { getWorkspaceStatusWarning } from '../../../../shared/workspace-status-warning'
import { dismissWorktreeNotifications } from '../../../notifications/worktree-notification-dismissal'
import { defineMethod } from '../core'

export const WORKTREE_SET_METHOD = defineMethod({
  name: 'worktree.set',
  permission: 'workspace',
  params: WorktreeSet,
  handler: async (params, { runtime }) => {
    const worktree = await runtime.updateManagedWorktreeMeta(params.worktree, {
      displayName: params.displayName,
      ...(params.firstAgentMessageRenameError === null
        ? { firstAgentMessageRenameError: null }
        : {}),
      ...(params.displayName !== undefined
        ? { displayNameIsPinned: displayNameUpdatePinsLabel(params.displayName) }
        : {}),
      linkedIssue: params.linkedIssue,
      linkedPR: params.linkedPR,
      suppressedGitHubPR: params.suppressedGitHubPR,
      linkedLinearIssue: params.linkedLinearIssue,
      linkedLinearIssueWorkspaceId: params.linkedLinearIssueWorkspaceId,
      linkedLinearIssueOrganizationUrlKey: params.linkedLinearIssueOrganizationUrlKey,
      linkedGitLabMR: params.linkedGitLabMR,
      linkedGitLabIssue: params.linkedGitLabIssue,
      linkedBitbucketPR: params.linkedBitbucketPR,
      linkedAzureDevOpsPR: params.linkedAzureDevOpsPR,
      linkedGiteaPR: params.linkedGiteaPR,
      linkedWorkItem: params.linkedWorkItem,
      linkedItems: params.linkedItems,
      ...(params.linkedItemsBase !== undefined ? { linkedItemsBase: params.linkedItemsBase } : {}),
      ...(params.linkedItemsSelectionChanged !== undefined
        ? { linkedItemsSelectionChanged: params.linkedItemsSelectionChanged }
        : {}),
      linkedTaskSourceContext: params.linkedTaskSourceContext,
      comment: params.comment,
      isArchived: params.isArchived,
      isUnread: params.isUnread,
      isPinned: params.isPinned,
      sortOrder: params.sortOrder,
      manualOrder: params.manualOrder,
      lastActivityAt: params.lastActivityAt,
      createdAt: params.createdAt,
      sparseDirectories: params.sparseDirectories,
      sparseBaseRef: params.sparseBaseRef,
      sparsePresetId: params.sparsePresetId,
      baseRef: params.baseRef,
      workspaceStatus: params.workspaceStatus,
      pushTarget: params.pushTarget,
      diffComments: params.diffComments,
      ...(params.diffCommentsBase !== undefined
        ? { diffCommentsBase: params.diffCommentsBase }
        : {}),
      mobileDiffReview: params.mobileDiffReview,
      lineage:
        params.parentWorktree || params.noParent === true
          ? {
              parentWorktree: params.parentWorktree,
              noParent: params.noParent === true
            }
          : undefined
    })
    if (params.isUnread === false) {
      // A whole-worktree read can arrive from the CLI or orchestration with no
      // focused window to drive the renderer's dismiss path; retire its
      // announced notifications here so desktop ones close too (#37328). The
      // Electron process installs the retirement; headless builds no-op.
      dismissWorktreeNotifications(worktree.id, runtime)
    }
    const warning = getWorkspaceStatusWarning(
      params.workspaceStatus,
      () => runtime.getUIState().workspaceStatuses
    )
    return { worktree, ...(warning ? { warnings: [warning] } : {}) }
  }
})
