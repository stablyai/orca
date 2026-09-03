import { randomUUID } from 'node:crypto'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeStoredTaskSourceContext } from '../../../shared/task-source-context'
import { normalizeWorkspaceLinkedItem } from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../../shared/workspace-statuses'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { WORKTREE_META_PERSISTED_DEFAULTS } from '../../../shared/worktree/meta-persisted-defaults'
import { normalizeGitHubPRSuppressionUpdate } from '../../../shared/worktree/github-pr-suppression'

type WorktreeMetaIdentity = {
  instanceId: string
  hostId: ExecutionHostId
}

// Why spread the shared table: it is what the serializer omits and the loader re-fills, so the two
// must never drift.
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

/** Merge and normalize the metadata shape shared by legacy and identity-keyed writes. */
export function mergeWorktreeMetaForWrite(
  existing: WorktreeMeta | undefined,
  updates: Partial<WorktreeMeta>,
  identity?: WorktreeMetaIdentity
): WorktreeMeta {
  const updated = {
    ...(existing ?? createDefaultWorktreeMeta()),
    ...normalizeGitHubPRSuppressionUpdate(updates),
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
