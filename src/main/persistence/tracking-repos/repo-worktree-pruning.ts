import { SessionUnitReader } from '../../../shared/session-unit-reader'
import { sessionPublication } from '../loading-store/session-publication'
import { runSessionOperation } from '../loading-store/session-operation'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { withoutWslMoveFrozenOwners } from '../restoring-sessions/session-owner-removal'
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
  collectPrefixedKeys(Object.keys(state.worktreeMeta))
  const publication = sessionPublication(state)
  for (const key of [
    LOCAL_EXECUTION_HOST_ID,
    ...Object.keys(state.workspaceSessionsByHostId ?? {})
  ]) {
    const partitionHostId = normalizeExecutionHostId(key)
    if (!partitionHostId) {
      continue
    }
    const { root, index } = publication.partition(partitionHostId)
    const reader = new SessionUnitReader(root, index)
    collectPrefixedKeys(reader.affectedOwners(reader.selectReferences([{ kind: 'repo', id }])))
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
    const kept = withoutWslMoveFrozenOwners(ownerKeysToPrune)
    runSessionOperation(state, LOCAL_EXECUTION_HOST_ID, {
      type: 'removeOwners',
      owners: [...kept],
      advanceRevision: false
    })
  }
  for (const key of Object.keys(state.workspaceSessionsByHostId ?? {})) {
    const partitionHostId = normalizeExecutionHostId(key)
    if (!partitionHostId || (!pruneAllHostPartitions && partitionHostId !== hostId)) {
      continue
    }
    runSessionOperation(state, partitionHostId, {
      type: 'removeOwners',
      owners: [...ownerKeysToPrune],
      advanceRevision: false
    })
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
