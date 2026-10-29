import { SessionUnitIndex } from '../../../shared/session-unit-index'
import { runSessionOperation, prepareSessionOperation } from '../loading-store/session-operation'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { workspaceSessionPartitionHostId } from '../../../shared/workspace-session-partition-owner'
import { isWslMoveWorkspaceSessionFrozen } from '../moving-wsl-projects/wsl-move-scope-guard'

/** Frozen WSL sessions must survive pruning for downgrade. */
export function withoutWslMoveFrozenOwners(ownerKeys: ReadonlySet<string>): ReadonlySet<string> {
  const kept = [...ownerKeys].filter((ownerKey) => !isWslMoveWorkspaceSessionFrozen(ownerKey))
  return kept.length === ownerKeys.size ? ownerKeys : new Set(kept)
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
  runSessionOperation(state, LOCAL_EXECUTION_HOST_ID, {
    type: 'removeOwners',
    owners: [ownerKey],
    advanceRevision: options.advanceTerminalTopologyRevision ?? false
  })
  for (const key of Object.keys(state.workspaceSessionsByHostId ?? {})) {
    const hostId = normalizeExecutionHostId(key)
    if (hostId) {
      runSessionOperation(state, hostId, {
        type: 'removeOwners',
        owners: [ownerKey],
        advanceRevision: options.advanceTerminalTopologyRevision ?? false
      })
    }
  }
}

export function removeWorkspaceSessionOwner(
  session: WorkspaceSessionState | undefined,
  ownerKey: string,
  options: { advanceTerminalTopologyRevision?: boolean } = {}
): WorkspaceSessionState | undefined {
  if (!session) {
    return session
  }
  return prepareSessionOperation(
    session,
    {
      type: 'removeOwners',
      owners: [ownerKey],
      advanceRevision: options.advanceTerminalTopologyRevision ?? false
    },
    new SessionUnitIndex(session)
  ).snapshot()
}

// Clone once and scan each collection once for all owners, avoiding per-owner work across host partitions.
export function removeWorkspaceSessionOwners(
  session: WorkspaceSessionState | undefined,
  ownerKeys: ReadonlySet<string>
): WorkspaceSessionState | undefined {
  if (!session || ownerKeys.size === 0) {
    return session
  }
  return prepareSessionOperation(
    session,
    {
      type: 'removeOwners',
      owners: [...ownerKeys],
      advanceRevision: false
    },
    new SessionUnitIndex(session)
  ).snapshot()
}

export function removeWorkspaceSessionOwnersEverywhere(
  state: Pick<PersistedState, 'workspaceSession' | 'workspaceSessionsByHostId'>,
  allOwnerKeys: ReadonlySet<string>
): void {
  const ownerKeys = withoutWslMoveFrozenOwners(allOwnerKeys)
  if (ownerKeys.size === 0) {
    return
  }
  runSessionOperation(state, LOCAL_EXECUTION_HOST_ID, {
    type: 'removeOwners',
    owners: [...ownerKeys],
    advanceRevision: false
  })
  for (const key of Object.keys(state.workspaceSessionsByHostId ?? {})) {
    const hostId = normalizeExecutionHostId(key)
    if (hostId) {
      runSessionOperation(state, hostId, {
        type: 'removeOwners',
        owners: [...ownerKeys],
        advanceRevision: false
      })
    }
  }
}
