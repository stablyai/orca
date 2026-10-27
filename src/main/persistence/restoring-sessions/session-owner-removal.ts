import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { workspaceSessionPartitionHostId } from '../../../shared/workspace-session-partition-owner'
import { isWslMoveWorkspaceSessionFrozen } from '../moving-wsl-projects/wsl-move-scope-guard'
import { cloneWorkspaceSessionState, deleteOwnerKeyedSessionFields } from './session-owner-fields'

/** Frozen WSL sessions must survive pruning for downgrade. */
export function withoutWslMoveFrozenOwners(ownerKeys: ReadonlySet<string>): ReadonlySet<string> {
  const kept = [...ownerKeys].filter((ownerKey) => !isWslMoveWorkspaceSessionFrozen(ownerKey))
  return kept.length === ownerKeys.size ? ownerKeys : new Set(kept)
}

// Batch owners into one scan per collection; per-owner scans multiply work across hosts.
export function deleteScannedSessionFieldsForOwners(
  next: WorkspaceSessionState,
  removedTabIds: ReadonlySet<string>,
  isRemovedOwner: (worktreeId: string) => boolean
): void {
  if (next.terminalPtyIncarnationsByPaneKey) {
    next.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
      Object.entries(next.terminalPtyIncarnationsByPaneKey).filter(([paneKey]) => {
        const separator = paneKey.lastIndexOf(':')
        return separator < 1 || !removedTabIds.has(paneKey.slice(0, separator))
      })
    )
  }
  if (next.terminalSurfaceTombstonesByPaneKey) {
    next.terminalSurfaceTombstonesByPaneKey = Object.fromEntries(
      Object.entries(next.terminalSurfaceTombstonesByPaneKey).filter(
        ([, tombstone]) => !isRemovedOwner(tombstone.worktreeId)
      )
    )
  }
  if (next.sleepingAgentSessionsByPaneKey) {
    for (const [paneKey, record] of Object.entries(next.sleepingAgentSessionsByPaneKey)) {
      if (isRemovedOwner(record.worktreeId)) {
        delete next.sleepingAgentSessionsByPaneKey[paneKey]
      }
    }
  }
  // Close evidence expires with the workspace it governs.
  if (next.closedTerminalTabTombstonesByTabId) {
    for (const [tabId, record] of Object.entries(next.closedTerminalTabTombstonesByTabId)) {
      if (isRemovedOwner(record.worktreeId)) {
        delete next.closedTerminalTabTombstonesByTabId[tabId]
      }
    }
  }
  if (next.closedTerminalPanesByPaneKey) {
    for (const [paneKey, record] of Object.entries(next.closedTerminalPanesByPaneKey)) {
      if (isRemovedOwner(record.worktreeId)) {
        delete next.closedTerminalPanesByPaneKey[paneKey]
      }
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

export const workspaceSessionOwnerPartitionForHost = workspaceSessionPartitionHostId

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
  deleteOwnerKeyedSessionFields(next, ownerKey, removedTabIds, options)
  deleteScannedSessionFieldsForOwners(next, removedTabIds, (worktreeId) => worktreeId === ownerKey)
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
  for (const ownerKey of ownerKeys) {
    deleteOwnerKeyedSessionFields(next, ownerKey, removedTabIds)
  }
  deleteScannedSessionFieldsForOwners(next, removedTabIds, (worktreeId) =>
    ownerKeys.has(worktreeId)
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
