import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeStoredTaskSourceContext } from '../../../shared/task-source-context'
import { normalizeWorkspaceLinkedItem } from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../../shared/workspace-statuses'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../../shared/worktree/meta-persisted-defaults'
import { normalizeGitHubPRSuppressionUpdate } from '../../../shared/worktree/github-pr-suppression'
import type { WorkspaceAttachmentMutation } from '../../../shared/workspace-attachment-mutation'
import { normalizeWorkspaceAttachmentUpdate } from '../../../shared/workspace-attachments'
import {
  mergeDiffCommentMutation,
  type DiffCommentBaseMutation
} from '../../../shared/diff-comment-mutation'

type WorktreeMetaIdentity = {
  instanceId: string
  hostId: ExecutionHostId
}

// Use the serializer/loader default table so omitted fields rehydrate identically.
function createDefaultWorktreeMeta(): WorktreeMeta {
  return {
    ...WORKTREE_META_PERSISTED_DEFAULTS,
    instanceId: randomUUID(),
    displayName: '',
    comment: '',
    isUnread: false,
    sortOrder: Date.now(),
    lastActivityAt: 0,
    workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID
  }
}

export function mergeWorktreeMetaForWrite(
  existing: WorktreeMeta | undefined,
  updates: Partial<WorktreeMeta> & WorkspaceAttachmentMutation & DiffCommentBaseMutation,
  identity?: WorktreeMetaIdentity
): WorktreeMeta {
  const { diffCommentsBase, ...metaUpdates } = updates
  if (diffCommentsBase !== undefined && metaUpdates.diffComments !== undefined) {
    metaUpdates.diffComments = mergeDiffCommentMutation(
      diffCommentsBase,
      existing?.diffComments ?? [],
      metaUpdates.diffComments
    )
  }
  const normalizedUpdates = normalizeWorkspaceAttachmentUpdate(existing, metaUpdates)
  const updated = {
    ...(existing ?? createDefaultWorktreeMeta()),
    ...normalizeGitHubPRSuppressionUpdate(normalizedUpdates),
    ...identity
  }
  updated.linkedWorkItem = normalizeWorkspaceLinkedItem(updated.linkedWorkItem)
  const sourceContext = normalizeStoredTaskSourceContext(updated.linkedTaskSourceContext)
  updated.linkedTaskSourceContext = isWorkspaceLinkedItemSourceContextMatch(
    updated.linkedWorkItem,
    sourceContext
  )
    ? sourceContext
    : null
  updated.instanceId ||= randomUUID()
  return updated
}
