import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { cloneWorkspaceSessionState, deleteOwnerKeyedSessionFields } from './session-owner-fields'

// Scans the pane-key-keyed maps and the shutdown list once, removing every entry
// owned by a key matched by `isRemovedOwner` (or, for pty incarnations, whose tab
// was removed). Kept separate from the O(1) deletes so a batch prune scans each
// collection a single time regardless of how many owners are being removed.
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
  next.activeWorktreeIdsOnShutdown = next.activeWorktreeIdsOnShutdown?.filter(
    (worktreeId) => !isRemovedOwner(worktreeId)
  )
}

// Remote (ssh:/runtime:) workspace state can exist in both the renderer's local blob and main's host
// partition, because the renderer falls back to 'local' whenever worktree ownership is unresolved.
export function workspaceSessionPartitionIdsForHost(
  hostId: string | null | undefined
): ExecutionHostId[] {
  const parsed = parseExecutionHostId(hostId)
  return parsed && parsed.id !== LOCAL_EXECUTION_HOST_ID
    ? [LOCAL_EXECUTION_HOST_ID, parsed.id]
    : [LOCAL_EXECUTION_HOST_ID]
}

/** The partition the host actually owns; the others are only spill surfaces for it. */
export function workspaceSessionOwnerPartitionForHost(
  hostId: string | null | undefined
): ExecutionHostId {
  return parseExecutionHostId(hostId)?.id ?? LOCAL_EXECUTION_HOST_ID
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

// Batch variant of removeWorkspaceSessionOwner: prunes every owner in `ownerKeys`
// with a single structuredClone and a single scan of each collection, instead of
// one clone+scan per owner. Project removal can touch many worktrees across many
// host partitions, so the per-owner clones added up to O(worktrees × hosts).
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
