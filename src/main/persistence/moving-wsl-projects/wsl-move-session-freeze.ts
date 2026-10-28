/**
 * Once a move has paused a project, its workspaces' session stays exactly as the quiesce left it:
 * that slept state is what the move carries to the host, so a later renderer write must neither
 * change nor drop it. Every other workspace's rows, and the global fields, are taken as written.
 * Once the host owns the project, its native chat tabs are taken as written too.
 */
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import {
  mergeWorkspaceSessionArrayField,
  mergeWorkspaceSessionRecordField
} from '../../../shared/workspace-session-host-records'
import {
  filterWorkspaceRows,
  withoutWorkspaces,
  workspaceIdsNamedByPartition
} from '../../../shared/workspace-session-stranded-partition-adoption'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  hasWslMoveFrozenSessions,
  isWslMoveWorkspaceHostOwned,
  isWslMoveWorkspaceSessionFrozen
} from './wsl-move-scope-guard'
import { hostOwnedChatTabRows } from './wsl-move-host-owned-chat-tabs'

const CHAT_TAB_FIELDS = ['unifiedTabs', 'tabGroups', 'tabGroupLayouts'] as const

export function keepWslMoveFrozenSessions(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined,
  isFrozen: (workspaceId: string) => boolean,
  // Committed moves only: the project's existing chats stay on this computer and keep working.
  acceptsChatTabs: (workspaceId: string) => boolean = () => false
): WorkspaceSessionState {
  const frozen = new Set<string>()
  for (const workspaceId of workspaceIdsNamedByPartition(next)) {
    if (isFrozen(workspaceId)) {
      frozen.add(workspaceId)
    }
  }
  for (const workspaceId of prior ? workspaceIdsNamedByPartition(prior) : []) {
    if (isFrozen(workspaceId)) {
      frozen.add(workspaceId)
    }
  }
  if (frozen.size === 0) {
    return next
  }
  const merged = withoutWorkspaces(next, frozen)
  if (prior) {
    keepPriorRows(merged, prior, frozen)
  }
  for (const workspaceId of frozen) {
    const chatRows = acceptsChatTabs(workspaceId)
      ? hostOwnedChatTabRows(merged, next, workspaceId)
      : null
    if (chatRows) {
      for (const field of CHAT_TAB_FIELDS) {
        mergeWorkspaceSessionRecordField(merged, field, chatRows)
      }
    }
  }
  return merged
}

function keepPriorRows(
  merged: WorkspaceSessionState,
  prior: WorkspaceSessionState,
  frozen: ReadonlySet<string>
): void {
  const kept = filterWorkspaceRows(prior, (workspaceId) => frozen.has(workspaceId))
  for (const [field, ownership] of Object.entries(WORKSPACE_SESSION_FIELD_OWNERSHIP)) {
    if (!isSessionField(field) || ownership === 'global' || ownership === 'hostPrivate') {
      continue
    }
    if (ownership === 'worktreeArray') {
      mergeWorkspaceSessionArrayField(merged, field, kept)
    } else {
      mergeWorkspaceSessionRecordField(merged, field, kept)
    }
  }
}

function isSessionField(field: string): field is keyof WorkspaceSessionState {
  return Object.hasOwn(WORKSPACE_SESSION_FIELD_OWNERSHIP, field)
}

export function keepWslMoveFrozenSessionsForStore(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined
): WorkspaceSessionState {
  if (!hasWslMoveFrozenSessions()) {
    return next
  }
  return keepWslMoveFrozenSessions(
    next,
    prior,
    isWslMoveWorkspaceSessionFrozen,
    isWslMoveWorkspaceHostOwned
  )
}
