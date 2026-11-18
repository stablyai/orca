import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host/execution-host'
import '../../../shared/workspace-session/workspace-session-partition-owner'
import {
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { isWslMoveWorkspaceSessionFrozen } from '../moving-wsl-projects/quiescence/wsl-move-scope-guard'
import {
  cloneWorkspaceSessionState,
  deleteOwnerKeyedSessionFields,
  type RemovedOwnerFileIds
} from './session-owner-fields'
import { sessionFieldsRemovedWithWorkspace } from '../../orca-profiles/project-transfer/profile-project-session-field-disposition'
import { markdownFileIdCandidates } from '../../orca-profiles/project-transfer/profile-session-markdown-transfer'

const OWNER_PANE_KEYED_FIELDS = sessionFieldsRemovedWithWorkspace('ownerPaneKey')
const OWNER_ROW_FIELDS = sessionFieldsRemovedWithWorkspace('ownerRow')

/** Frozen WSL sessions must survive pruning for downgrade. */
export function withoutWslMoveFrozenOwners(ownerKeys: ReadonlySet<string>): ReadonlySet<string> {
  const kept = [...ownerKeys].filter((ownerKey) => !isWslMoveWorkspaceSessionFrozen(ownerKey))
  return kept.length === ownerKeys.size ? ownerKeys : new Set(kept)
}

// Batch owners into one scan per collection; per-owner scans multiply work across hosts.
export function deleteScannedSessionFieldsForOwners(
  next: WorkspaceSessionState,
  removedTabIds: ReadonlySet<string>,
  isRemovedOwner: (worktreeId: string) => boolean,
  removedFileIds: RemovedOwnerFileIds = new Set()
): void {
  if (removedTabIds.size > 0) {
    for (const field of OWNER_PANE_KEYED_FIELDS) {
      const record = next[field] as Record<string, unknown> | undefined
      for (const paneKey of Object.keys(record ?? {})) {
        const separator = paneKey.lastIndexOf(':')
        if (separator > 0 && removedTabIds.has(paneKey.slice(0, separator))) {
          delete record![paneKey]
        }
      }
    }
  }
  // Close evidence and resume records expire with the workspace they govern.
  for (const field of OWNER_ROW_FIELDS) {
    const record = next[field]
    if (!isSessionRecord(record)) {
      continue
    }
    for (const [key, row] of Object.entries(record)) {
      const worktreeId = sessionRowWorktreeId(row)
      if (worktreeId && isRemovedOwner(worktreeId)) {
        delete record[key]
      }
    }
  }
  if (removedFileIds.size > 0 && next.markdownFrontmatterVisible) {
    // A surviving workspace may open the same path; its file keeps the shared ID.
    for (const [ownerKey, files] of Object.entries(next.openFilesByWorktree ?? {})) {
      for (const file of files) {
        for (const id of markdownFileIdCandidates(
          file.filePath,
          ownerKey,
          file.runtimeEnvironmentId
        )) {
          removedFileIds.delete(id)
        }
      }
    }
    for (const id of removedFileIds) {
      delete next.markdownFrontmatterVisible[id]
    }
  }
  // One scan for all owners; keys may be host-qualified executionHostId|worktreeId.
  for (const key of Object.keys(next.lastVisitedAtByWorktreeId ?? {})) {
    const rawId = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
    if (isRemovedOwner(key) || isRemovedOwner(rawId)) {
      delete next.lastVisitedAtByWorktreeId![key]
    }
  }
  next.activeWorktreeIdsOnShutdown = next.activeWorktreeIdsOnShutdown?.filter(
    (worktreeId) => !isRemovedOwner(worktreeId)
  )
}

// Unresolved remote ownership can spill renderer rows into local as well as the host partition.
export function workspaceSessionPartitionIdsForHost(
  hostId: string | null | undefined
): ExecutionHostId[] {
  const parsed = parseExecutionHostId(hostId)
  return parsed && parsed.id !== LOCAL_EXECUTION_HOST_ID
    ? [LOCAL_EXECUTION_HOST_ID, parsed.id]
    : [LOCAL_EXECUTION_HOST_ID]
}

/** Delete every partition copy or load may resurrect the workspace; folder host ownership can be inferred. */
export function removeWorkspaceSessionOwnerEverywhere(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  ownerKey: string,
  options: { advanceTerminalTopologyRevision?: boolean } = {}
): void {
  if (isWslMoveWorkspaceSessionFrozen(ownerKey)) {
    return
  }
  state.workspaceSession = removeWorkspaceSessionOwner(state.workspaceSession, ownerKey, options)!
  const partitions = state.workspaceSessionsByHostId
  if (!partitions) {
    return
  }
  const next: Record<string, WorkspaceSessionState> = {}
  for (const [hostId, partition] of Object.entries(partitions)) {
    if (partition) {
      next[hostId] = removeWorkspaceSessionOwner(partition, ownerKey, options)!
    }
  }
  state.workspaceSessionsByHostId = next
}

export function removeWorkspaceSessionOwner(
  session: WorkspaceSessionState | undefined,
  ownerKey: string,
  options: { advanceTerminalTopologyRevision?: boolean } = {}
): WorkspaceSessionState | undefined {
  if (!session) {
    return session
  }
  const next = cloneWorkspaceSessionState(session)
  const removedTabIds = new Set<string>()
  const removedFileIds: RemovedOwnerFileIds = new Set()
  deleteOwnerKeyedSessionFields(next, ownerKey, removedTabIds, options, removedFileIds)
  deleteScannedSessionFieldsForOwners(
    next,
    removedTabIds,
    (worktreeId) => worktreeId === ownerKey,
    removedFileIds
  )
  return next
}

// Clone once and scan each collection once for all owners, avoiding per-owner work across host partitions.
export function removeWorkspaceSessionOwners(
  session: WorkspaceSessionState | undefined,
  ownerKeys: ReadonlySet<string>
): WorkspaceSessionState | undefined {
  if (!session || ownerKeys.size === 0) {
    return session
  }
  const next = cloneWorkspaceSessionState(session)
  const removedTabIds = new Set<string>()
  const removedFileIds: RemovedOwnerFileIds = new Set()
  for (const ownerKey of ownerKeys) {
    deleteOwnerKeyedSessionFields(next, ownerKey, removedTabIds, {}, removedFileIds)
  }
  deleteScannedSessionFieldsForOwners(
    next,
    removedTabIds,
    (worktreeId) => ownerKeys.has(worktreeId),
    removedFileIds
  )
  return next
}

export function removeWorkspaceSessionOwnersEverywhere(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  allOwnerKeys: ReadonlySet<string>
): void {
  const ownerKeys = withoutWslMoveFrozenOwners(allOwnerKeys)
  if (ownerKeys.size === 0) {
    return
  }
  state.workspaceSession = removeWorkspaceSessionOwners(state.workspaceSession, ownerKeys)!
  const partitions = state.workspaceSessionsByHostId
  if (!partitions) {
    return
  }
  const next: Record<string, WorkspaceSessionState> = {}
  for (const [hostId, partition] of Object.entries(partitions)) {
    if (partition) {
      next[hostId] = removeWorkspaceSessionOwners(partition, ownerKeys)!
    }
  }
  state.workspaceSessionsByHostId = next
}

/** The workspace a session record row names, if it names one. */
export function sessionRowWorktreeId(row: unknown): string | undefined {
  return typeof row === 'object' &&
    row !== null &&
    'worktreeId' in row &&
    typeof row.worktreeId === 'string'
    ? row.worktreeId
    : undefined
}

function isSessionRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
