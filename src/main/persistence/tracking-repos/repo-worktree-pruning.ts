import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  removeWorkspaceSessionOwners,
  withoutWslMoveFrozenOwners
} from '../restoring-sessions/session-owner-removal'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  isWorktreeHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { pruneUnreferencedWorktreeIdentityMeta } from '../loading-store/worktree-identity-metadata'

export function pruneWorktreeStateForRepo(
  state: PersistedState,
  id: string,
  hostId: ExecutionHostId | null,
  pruneMobileClientTabSelections: (matchesWorktreeId: (worktreeId: string) => boolean) => void
): void {
  const prefix = `${id}::`
  // Capture host stamps before deletion or later checks could misclassify SSH rows as local.
  const hostMembership = new Map<string, boolean>()
  const belongsToHost = (key: string): boolean => {
    if (!key.startsWith(prefix)) {
      return false
    }
    if (hostId === null) {
      return true
    }
    const cached = hostMembership.get(key)
    if (cached !== undefined) {
      return cached
    }
    // Unstamped legacy metadata defaults local; remote pruning cannot claim it safely.
    const metaHostId = state.worktreeMeta[key]?.hostId ?? LOCAL_EXECUTION_HOST_ID
    const result = metaHostId === hostId
    hostMembership.set(key, result)
    return result
  }
  // Collect owner keys before deleting metadata; per-partition gates prevent orphan resurrection across hosts.
  const ownerKeysToPrune = new Set<string>()
  const collectPrefixedKeys = (keys: Iterable<string>): void => {
    for (const key of keys) {
      const rawKey = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
      const keyHost = isWorktreeHostIdentity(key) ? key.slice(0, key.indexOf('|')) : null
      // Bare keys defer host proof to partitions; qualified keys require matching hosts here.
      // Empty qualifiers live in local and must be claimed by local pruning to prevent resurrection.
      const belongsToPrunedHost =
        hostId === null ||
        keyHost === null ||
        keyHost === hostId ||
        (keyHost === '' && hostId === LOCAL_EXECUTION_HOST_ID)
      if (belongsToPrunedHost && rawKey.startsWith(prefix)) {
        ownerKeysToPrune.add(key)
      }
    }
  }
  // Pane-keyed evidence can own workspaces with no metadata/visit rows; collect it to avoid permanent orphans.
  const collectScannedRecordOwners = (session: WorkspaceSessionState | undefined): void => {
    collectPrefixedKeys(Object.keys(session?.lastVisitedAtByWorktreeId ?? {}))
    collectPrefixedKeys(
      Object.values(session?.sleepingAgentSessionsByPaneKey ?? {}).map(
        (record) => record.worktreeId
      )
    )
    collectPrefixedKeys(
      Object.values(session?.terminalSurfaceTombstonesByPaneKey ?? {}).map(
        (tombstone) => tombstone.worktreeId
      )
    )
    collectPrefixedKeys(
      Object.values(session?.closedTerminalTabTombstonesByTabId ?? {}).map(
        (record) => record.worktreeId
      )
    )
  }
  collectPrefixedKeys(Object.keys(state.worktreeMeta))
  collectScannedRecordOwners(state.workspaceSession)
  for (const session of Object.values(state.workspaceSessionsByHostId ?? {})) {
    collectScannedRecordOwners(session)
  }

  for (const key of Object.keys(state.worktreeMeta)) {
    if (belongsToHost(key)) {
      delete state.worktreeMeta[key]
    }
  }
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    const rawId = getWorktreeIdFromHostIdentity(alias)
    const aliasHost = getExecutionHostIdFromWorktreeHostIdentity(alias)
    if (rawId.startsWith(prefix) && (hostId === null || aliasHost === hostId)) {
      delete state.worktreeIdentityAliases?.[alias]
    }
  }
  pruneUnreferencedWorktreeIdentityMeta(state)
  // Host-scoped removal preserves sibling sessions; only full removal may clear all partitions.
  const pruneLegacyLocalSession = hostId === null || hostId === LOCAL_EXECUTION_HOST_ID
  const pruneAllHostPartitions = hostId === null
  if (pruneLegacyLocalSession) {
    state.workspaceSession = removeWorkspaceSessionOwners(
      state.workspaceSession,
      withoutWslMoveFrozenOwners(ownerKeysToPrune)
    )!
  }
  if (state.workspaceSessionsByHostId) {
    for (const [partitionHostId, session] of Object.entries(state.workspaceSessionsByHostId)) {
      if (!pruneAllHostPartitions && partitionHostId !== hostId) {
        continue
      }
      const pruned = removeWorkspaceSessionOwners(session, ownerKeysToPrune)
      if (pruned) {
        state.workspaceSessionsByHostId[partitionHostId] = pruned
      }
    }
  }
  for (const [childId, lineage] of Object.entries(state.worktreeLineageById)) {
    if (belongsToHost(childId) || belongsToHost(lineage.parentWorktreeId)) {
      delete state.worktreeLineageById[childId]
    }
  }
  for (const [childKey, lineage] of Object.entries(state.workspaceLineageByChildKey)) {
    const childScope = parseWorkspaceKey(childKey)
    const parentScope = parseWorkspaceKey(lineage.parentWorkspaceKey)
    if (childScope?.type === 'worktree' && belongsToHost(childScope.worktreeId)) {
      delete state.workspaceLineageByChildKey[childKey as WorkspaceKey]
      continue
    }
    if (parentScope?.type === 'worktree' && belongsToHost(parentScope.worktreeId)) {
      delete state.workspaceLineageByChildKey[childKey as WorkspaceKey]
    }
  }
  pruneMobileClientTabSelections(belongsToHost)
}
