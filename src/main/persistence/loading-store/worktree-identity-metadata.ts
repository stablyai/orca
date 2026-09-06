import { randomUUID } from 'node:crypto'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'
import { mergeWorktreeMetaForWrite } from './worktree-meta-write-normalization'

type MetadataRuntime = Pick<StoreRuntimeState, 'state'>

/** Select one readable row without discarding competing alias candidates. */
function resolveAliasIdentityKey(state: PersistedState, alias: string): string | undefined {
  const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
  if (identityKeys.length === 0) {
    return undefined
  }
  const resolvable = identityKeys.filter((key) => state.worktreeMetaByIdentity?.[key])
  const candidates = resolvable.length > 0 ? resolvable : identityKeys
  // Newest activity wins, then the greater key, so every host agrees on the survivor.
  const winner = candidates.reduce((best, key) => {
    const bestTouch = state.worktreeMetaByIdentity?.[best]?.lastActivityAt ?? 0
    const keyTouch = state.worktreeMetaByIdentity?.[key]?.lastActivityAt ?? 0
    if (keyTouch !== bestTouch) {
      return keyTouch > bestTouch ? key : best
    }
    return key > best ? key : best
  })
  return winner
}

/** Drop identity metadata no alias points at any more. */
export function pruneUnreferencedWorktreeIdentityMeta(
  state: PersistedState,
  candidates?: ReadonlySet<string>
): boolean {
  const referenced = new Set(Object.values(state.worktreeIdentityAliases ?? {}).flat())
  let changed = false
  const identityKeys = candidates ?? Object.keys(state.worktreeMetaByIdentity ?? {})
  for (const identityKey of identityKeys) {
    if (
      Object.hasOwn(state.worktreeMetaByIdentity ?? {}, identityKey) &&
      !referenced.has(identityKey)
    ) {
      delete state.worktreeMetaByIdentity?.[identityKey]
      changed = true
    }
  }
  return changed
}

function migrateLegacyWorktreeMetadata(
  state: PersistedState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): boolean {
  const meta = state.worktreeMeta[worktreeId]
  if (!meta || (meta.hostId !== undefined && meta.hostId !== executionHostId)) {
    return false
  }
  state.worktreeMetaByIdentity ??= {}
  state.worktreeIdentityAliases ??= {}
  let changed = false
  const instanceId = meta.instanceId ?? randomUUID()
  if (!meta.instanceId) {
    meta.instanceId = instanceId
    changed = true
  }
  if (!meta.hostId) {
    meta.hostId = executionHostId
    changed = true
  }
  const identityKey = canonicalWorktreeIdentity({
    worktreeId,
    executionHostId,
    instanceId
  })
  if (!state.worktreeMetaByIdentity[identityKey]) {
    state.worktreeMetaByIdentity[identityKey] = {
      ...meta,
      instanceId,
      hostId: executionHostId
    }
    changed = true
  }
  const alias = composeWorktreeHostIdentity(executionHostId, worktreeId)
  const aliases = state.worktreeIdentityAliases[alias] ?? []
  if (aliases.length === 0) {
    state.worktreeIdentityAliases[alias] = [identityKey]
    changed = true
  }
  return changed
}

/** Drop the identity rows a locator owns, for one host or for every host. */
export function removeWorktreeMetadataForHost(
  state: PersistedState,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): boolean {
  let changed = false
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    if (getWorktreeIdFromHostIdentity(alias) !== worktreeId) {
      continue
    }
    if (
      executionHostId !== undefined &&
      getExecutionHostIdFromWorktreeHostIdentity(alias) !== executionHostId
    ) {
      continue
    }
    delete state.worktreeIdentityAliases?.[alias]
    changed = true
  }
  return pruneUnreferencedWorktreeIdentityMeta(state) || changed
}

/**
 * Re-point one host's alias at a renamed locator. Host-scoped on purpose: a local
 * folder move must not drag a remote host's alias to a path that host does not have.
 */
export function migrateWorktreeMetadataLocator(
  state: PersistedState,
  oldWorktreeId: string,
  newWorktreeId: string,
  executionHostId: ExecutionHostId
): boolean {
  if (oldWorktreeId === newWorktreeId) {
    return false
  }
  const oldAlias = composeWorktreeHostIdentity(executionHostId, oldWorktreeId)
  const identityKeys = state.worktreeIdentityAliases?.[oldAlias]
  if (!identityKeys || identityKeys.length === 0) {
    return false
  }
  const newAlias = composeWorktreeHostIdentity(executionHostId, newWorktreeId)
  state.worktreeIdentityAliases ??= {}
  // A taken destination keeps its own occupant; stranding the mover at the old locator loses less
  // than merging (which makes both unreadable) or dropping its row outright.
  if ((state.worktreeIdentityAliases[newAlias] ?? []).length > 0) {
    return false
  }
  state.worktreeIdentityAliases[newAlias] = [...identityKeys]
  delete state.worktreeIdentityAliases[oldAlias]
  return true
}
export function getWorktreeMetaForHost(
  runtime: MetadataRuntime,
  scheduling: WriteSchedulingOperations,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeMeta | undefined {
  const state = runtime.state
  const changed = migrateLegacyWorktreeMetadata(state, worktreeId, executionHostId)
  const alias = composeWorktreeHostIdentity(executionHostId, worktreeId)
  const identityKey = resolveAliasIdentityKey(state, alias)
  if (changed) {
    scheduleSave(scheduling)
  }
  if (identityKey) {
    return state.worktreeMetaByIdentity?.[identityKey]
  }
  const legacy = state.worktreeMeta[worktreeId]
  return !legacy?.hostId || legacy.hostId === executionHostId ? legacy : undefined
}

/** Read-only host projection used by listings that must include canonical-only rows. */
export function getAllWorktreeMetaForHost(
  runtime: MetadataRuntime,
  executionHostId: ExecutionHostId
): Record<string, WorktreeMeta> {
  const state = runtime.state
  const projected: Record<string, WorktreeMeta> = {}
  for (const [worktreeId, meta] of Object.entries(state.worktreeMeta)) {
    if (!meta.hostId || meta.hostId === executionHostId) {
      projected[worktreeId] = meta
    }
  }
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    if (getExecutionHostIdFromWorktreeHostIdentity(alias) !== executionHostId) {
      continue
    }
    const worktreeId = getWorktreeIdFromHostIdentity(alias)
    const identityKey = resolveAliasIdentityKey(state, alias)
    const meta = identityKey ? state.worktreeMetaByIdentity?.[identityKey] : undefined
    if (!worktreeId || !meta || (meta.hostId && meta.hostId !== executionHostId)) {
      continue
    }
    projected[worktreeId] =
      meta.hostId === executionHostId ? meta : { ...meta, hostId: executionHostId }
  }
  return projected
}

export function setWorktreeMetaForHost(
  runtime: MetadataRuntime,
  scheduling: WriteSchedulingOperations,
  worktreeId: string,
  executionHostId: ExecutionHostId,
  meta: Partial<WorktreeMeta>
): WorktreeMeta {
  const state = runtime.state
  migrateLegacyWorktreeMetadata(state, worktreeId, executionHostId)
  const alias = composeWorktreeHostIdentity(executionHostId, worktreeId)
  const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
  if (identityKeys.length > 1 && meta.instanceId === undefined) {
    throw new Error('Worktree identity is ambiguous for this host and locator.')
  }
  const existingIdentityKey = resolveAliasIdentityKey(state, alias)
  const existingIdentityMeta = existingIdentityKey
    ? state.worktreeMetaByIdentity?.[existingIdentityKey]
    : undefined
  const legacy = state.worktreeMeta[worktreeId]
  const existing =
    existingIdentityMeta ??
    (!legacy?.hostId || legacy.hostId === executionHostId ? legacy : undefined)
  // An explicit instanceId is a deliberate rotation (see worktree-lineage-pruning), so it wins.
  const instanceId = meta.instanceId ?? existing?.instanceId ?? randomUUID()
  const identityKey = canonicalWorktreeIdentity({ worktreeId, executionHostId, instanceId })
  const updated = mergeWorktreeMetaForWrite(existing, meta, {
    instanceId,
    hostId: executionHostId
  })
  state.worktreeMetaByIdentity ??= {}
  state.worktreeIdentityAliases ??= {}
  if (existingIdentityKey && existingIdentityKey !== identityKey) {
    delete state.worktreeMetaByIdentity[existingIdentityKey]
  }
  state.worktreeMetaByIdentity[identityKey] = updated
  state.worktreeIdentityAliases[alias] = [identityKey]
  // Keep the legacy projection only for the first known owner.
  if (!legacy || legacy.hostId === executionHostId) {
    state.worktreeMeta[worktreeId] = updated
  }
  scheduleSave(scheduling)
  return updated
}
