import { randomUUID } from 'node:crypto'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { canonicalWorktreeIdentity } from '../../../shared/worktree/identity'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import { isLocalOnlyWorktreeMetaId } from '../../../shared/worktree/local-only-worktree-meta-ids'
import {
  pruneUnreferencedWorktreeIdentityMeta,
  resolveAliasIdentityKey
} from './worktree-identity-metadata'

/**
 * Older builds left floating and setup terminal rows unstamped, or stamped them with whichever host
 * read them first. Either way the row projected onto a remote host and blocked its SSH access
 * (#31498), and a remote stamp hid it from this machine. Load moves them home: an existing local
 * or unstamped row wins, otherwise the newest remote one is re-keyed for the local host.
 */
export function rehomeLocalOnlyWorktreeMetadata(state: PersistedState): boolean {
  let changed = false
  const dropped = new Set<string>()
  const newestRemote = new Map<string, { identityKey: string; meta: WorktreeMeta }>()
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    const worktreeId = getWorktreeIdFromHostIdentity(alias)
    if (
      !isLocalOnlyWorktreeMetaId(worktreeId) ||
      getExecutionHostIdFromWorktreeHostIdentity(alias) === LOCAL_EXECUTION_HOST_ID
    ) {
      continue
    }
    const identityKey = resolveAliasIdentityKey(state, alias)
    const meta = identityKey ? state.worktreeMetaByIdentity?.[identityKey] : undefined
    const newest = newestRemote.get(worktreeId)
    if (identityKey && meta && (!newest || isNewer(identityKey, meta, newest))) {
      newestRemote.set(worktreeId, { identityKey, meta })
    }
    for (const key of state.worktreeIdentityAliases?.[alias] ?? []) {
      dropped.add(key)
    }
    delete state.worktreeIdentityAliases?.[alias]
    changed = true
  }
  for (const [worktreeId, { meta }] of newestRemote) {
    const localAlias = composeWorktreeHostIdentity(LOCAL_EXECUTION_HOST_ID, worktreeId)
    if (
      (state.worktreeIdentityAliases?.[localAlias] ?? []).length > 0 ||
      isLocalLocatorRow(state, worktreeId)
    ) {
      continue
    }
    const instanceId = meta.instanceId ?? randomUUID()
    const localKey = canonicalWorktreeIdentity({
      worktreeId,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      instanceId
    })
    state.worktreeMetaByIdentity ??= {}
    state.worktreeIdentityAliases ??= {}
    state.worktreeMetaByIdentity[localKey] = {
      ...meta,
      instanceId,
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    state.worktreeIdentityAliases[localAlias] = [localKey]
  }
  for (const [worktreeId, meta] of Object.entries(state.worktreeMeta)) {
    if (!isLocalOnlyWorktreeMetaId(worktreeId) || meta.hostId === LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    const localKey = resolveAliasIdentityKey(
      state,
      composeWorktreeHostIdentity(LOCAL_EXECUTION_HOST_ID, worktreeId)
    )
    // A fresh object: the old row may be shared with a remote identity row being dropped.
    state.worktreeMeta[worktreeId] = (localKey && state.worktreeMetaByIdentity?.[localKey]) || {
      ...meta,
      hostId: LOCAL_EXECUTION_HOST_ID
    }
    changed = true
  }
  if (dropped.size > 0) {
    pruneUnreferencedWorktreeIdentityMeta(state, dropped)
  }
  return changed
}

// An unstamped locator row is what local reads returned before, so it outranks a remote copy.
function isLocalLocatorRow(state: PersistedState, worktreeId: string): boolean {
  const locator = state.worktreeMeta[worktreeId]
  return (
    locator !== undefined && (locator.hostId ?? LOCAL_EXECUTION_HOST_ID) === LOCAL_EXECUTION_HOST_ID
  )
}

// Same order as resolveAliasIdentityKey: newest activity, then the greater key.
function isNewer(
  identityKey: string,
  meta: WorktreeMeta,
  current: { identityKey: string; meta: WorktreeMeta }
): boolean {
  const touch = meta.lastActivityAt ?? 0
  const currentTouch = current.meta.lastActivityAt ?? 0
  return touch !== currentTouch ? touch > currentTouch : identityKey > current.identityKey
}
