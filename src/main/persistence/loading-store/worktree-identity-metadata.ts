import type { WorkspaceAttachmentMutation } from '../../../shared/workspace-attachment-mutation'
import type { DiffCommentBaseMutation } from '../../../shared/diff-comment-mutation'
import { randomUUID } from 'node:crypto'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
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
import {
  isLocalOnlyWorktreeMetaId,
  worktreeMetaHostFor
} from '../../../shared/worktree/local-only-worktree-meta-ids'

type MetadataRuntime = Pick<StoreRuntimeState, 'state'>
type WorktreeMetaState = Pick<
  PersistedState,
  'worktreeMeta' | 'worktreeMetaByIdentity' | 'worktreeIdentityAliases'
>

export const WORKTREE_METADATA_DOMAINS = [
  'worktreeMeta',
  'worktreeMetaByIdentity',
  'worktreeIdentityAliases'
] as const

export function resolveAliasIdentityKey(
  state: WorktreeMetaState,
  alias: string
): string | undefined {
  const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
  if (identityKeys.length === 0) {
    return undefined
  }
  const resolvable = identityKeys.filter((key) => state.worktreeMetaByIdentity?.[key])
  const candidates = resolvable.length > 0 ? resolvable : identityKeys
  // Deterministic tie-breaking keeps hosts consistent: newest activity, then greatest key.
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

/** Migrate only this host's locator alias; local moves cannot rewrite another host's paths. */
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
  // Keep the source on destination collision rather than losing metadata or making both unreadable.
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
  requestedHostId: ExecutionHostId
): WorktreeMeta | undefined {
  const state = runtime.state
  const executionHostId = worktreeMetaHostFor(worktreeId, requestedHostId)
  const changed = migrateLegacyWorktreeMetadata(state, worktreeId, executionHostId)
  const alias = composeWorktreeHostIdentity(executionHostId, worktreeId)
  const identityKey = resolveAliasIdentityKey(state, alias)
  if (changed) {
    scheduleSave(scheduling, WORKTREE_METADATA_DOMAINS)
  }
  if (identityKey) {
    return state.worktreeMetaByIdentity?.[identityKey]
  }
  const legacy = state.worktreeMeta[worktreeId]
  return !legacy?.hostId || legacy.hostId === executionHostId ? legacy : undefined
}

// Local-only IDs cannot belong to remote hosts even when legacy rows lack stamps.
function isOtherHostsLocalOnlyRow(worktreeId: string, executionHostId: ExecutionHostId): boolean {
  return executionHostId !== LOCAL_EXECUTION_HOST_ID && isLocalOnlyWorktreeMetaId(worktreeId)
}

export function getAllWorktreeMetaForHost(
  runtime: { state: WorktreeMetaState },
  executionHostId: ExecutionHostId
): Record<string, WorktreeMeta> {
  const state = runtime.state
  const projected: Record<string, WorktreeMeta> = {}
  for (const [worktreeId, meta] of Object.entries(state.worktreeMeta)) {
    if (isOtherHostsLocalOnlyRow(worktreeId, executionHostId)) {
      continue
    }
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
    if (
      !worktreeId ||
      isOtherHostsLocalOnlyRow(worktreeId, executionHostId) ||
      !meta ||
      (meta.hostId && meta.hostId !== executionHostId)
    ) {
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
  requestedHostId: ExecutionHostId,
  meta: Partial<WorktreeMeta> & WorkspaceAttachmentMutation & DiffCommentBaseMutation
): WorktreeMeta {
  const state = runtime.state
  const executionHostId = worktreeMetaHostFor(worktreeId, requestedHostId)
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
  // Explicit instance IDs rotate identity; otherwise preserve the existing incarnation.
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
  // Only the first known host owns the legacy locator projection.
  if (!legacy || legacy.hostId === executionHostId) {
    state.worktreeMeta[worktreeId] = updated
  }
  scheduleSave(scheduling, WORKTREE_METADATA_DOMAINS)
  return updated
}
