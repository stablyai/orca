// Preserve quiesced workspace rows against later renderer writes; accept unrelated rows and globals.
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
import { hasWslMoveFrozenSessions, isWslMoveWorkspaceSessionFrozen } from './wsl-move-scope-guard'

export function keepWslMoveFrozenSessions(
  next: WorkspaceSessionState,
  prior: WorkspaceSessionState | undefined,
  isFrozen: (workspaceId: string) => boolean
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
  if (!prior) {
    return merged
  }
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
  return merged
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
  return keepWslMoveFrozenSessions(next, prior, isWslMoveWorkspaceSessionFrozen)
}
