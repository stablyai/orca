import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { removeWorkspaceSessionOwners } from '../restoring-sessions/session-owner-removal'
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
  // Why snapshot up front: the first loop deletes metas, so reading meta.hostId live later would misclassify an SSH worktree as local.
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
    // Why default to local: metas without hostId predate host stamping, so a host-scoped prune skips them rather than risk deleting another host's live meta.
    const metaHostId = state.worktreeMeta[key]?.hostId ?? LOCAL_EXECUTION_HOST_ID
    const result = metaHostId === hostId
    hostMembership.set(key, result)
    return result
  }
  // Why: leftover session owner keys re-materialize into worktreeMeta next launch as orphaned
  // "unknown" workspaces. Owner keys carry no host and can repeat across partitions, so collect every
  // prefix match (before the worktreeMeta deletes below) and let the per-partition gating decide.
  const ownerKeysToPrune = new Set<string>()
  const collectPrefixedKeys = (keys: Iterable<string>): void => {
    for (const key of keys) {
      const rawKey = isWorktreeHostIdentity(key) ? getWorktreeIdFromHostIdentity(key) : key
      const keyHost = isWorktreeHostIdentity(key) ? key.slice(0, key.indexOf('|')) : null
      // Why: bare keys are scoped by the per-partition gating below; only host-qualified
      // keys can sit in another host's partition and need host-matching at collection time.
      // Why the empty-host arm: the host split parks the canonical unknown-host form (`|<id>`) in
      // the local partition, so a local prune must claim it or the orphan restores next launch.
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
  // Why the pane-keyed records contribute owner keys: they are pruned by the worktreeId they name,
  // not by their own key, so a worktree with no meta and no visit row would otherwise keep its
  // sleeping agents and tombstones forever -- and keep re-seeding the orphan sweep every load.
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
  // Why: a host-scoped prune must touch only that host's session (legacy blob = local, one partition
  // per remote host); pruning every partition would wipe a surviving host's tabs and sleeping agents
  // for a shared repo id/path. A full removal (hostId === null) still clears every host.
  const pruneLegacyLocalSession = hostId === null || hostId === LOCAL_EXECUTION_HOST_ID
  const pruneAllHostPartitions = hostId === null
  if (pruneLegacyLocalSession) {
    state.workspaceSession = removeWorkspaceSessionOwners(state.workspaceSession, ownerKeysToPrune)!
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
