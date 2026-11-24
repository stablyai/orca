import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { normalizeStoredTaskSourceContext } from '../../../../shared/work-items/task-source-context'
import { normalizeWorkspaceLinkedItem } from '../../../../shared/workspace-attachments/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../../shared/workspace-attachments/workspace-linked-item-source-context'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../../../shared/workspace/status/workspace-statuses'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../../../shared/worktree/metadata/meta-persisted-defaults'
import { normalizeGitHubPRSuppressionUpdate } from '../../../../shared/worktree/hosted-review/github-pr-suppression'
import type { WorkspaceAttachmentMutation } from '../../../../shared/workspace-attachments/workspace-attachment-mutation'
import { normalizeWorkspaceAttachmentUpdate } from '../../../../shared/workspace-attachments/workspace-attachments'
import {
  applyDiffCommentWrite,
  type DiffCommentBaseMutation
} from '../../../../shared/file-review/diff-comment-mutation'
import { normalizeWorkspaceAgentTaskGroups } from '../../../../shared/agent-task-groups/agent-task-groups'

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
  const { diffCommentsBase: _diffCommentsBase, ...metaUpdates } = updates
  if (metaUpdates.diffComments !== undefined) {
    metaUpdates.diffComments = applyDiffCommentWrite(existing?.diffComments, updates)
  }
  const normalizedUpdates = normalizeWorkspaceAttachmentUpdate(existing, metaUpdates)
  const updated = {
    ...(existing ?? createDefaultWorktreeMeta()),
    ...normalizeGitHubPRSuppressionUpdate(normalizedUpdates, existing?.linkedPR),
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
  if (updates.agentTaskGroups !== undefined) {
    // Clients send the whole set; one with no valid group clears it rather than storing junk.
    const groups = normalizeWorkspaceAgentTaskGroups(updates.agentTaskGroups)
    if (groups) {
      updated.agentTaskGroups = groups
    } else {
      delete updated.agentTaskGroups
    }
  }
  updated.instanceId ||= randomUUID()
  return updated
}
