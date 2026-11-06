import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'

function liveCollectionIds(state: PersistedState): ReadonlySet<string> {
  return new Set((state.collections ?? []).map((collection) => collection.id))
}

/** Canonical membership: deduped live ids; empty drops the key so [] is never persisted. */
function normalizeMembership(meta: WorktreeMeta, live: ReadonlySet<string>): void {
  const raw: unknown = meta.collectionIds
  const ids = new Set(
    Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string' && live.has(id))
      : []
  )
  if (ids.size > 0) {
    meta.collectionIds = [...ids]
  } else {
    delete meta.collectionIds
  }
}

/** Why: single chokepoint for every membership writer (IPC updateMeta, worktree.set RPC). */
export function normalizeWrittenCollectionIds(state: PersistedState, updated: WorktreeMeta): void {
  if ('collectionIds' in updated) {
    normalizeMembership(updated, liveCollectionIds(state))
  }
}

/** Drops memberships of deleted collections; returns whether load must rewrite the profile. */
export function pruneCollectionMemberships(state: PersistedState): boolean {
  const live = liveCollectionIds(state)
  let changed = false
  for (const meta of Object.values(state.worktreeMeta ?? {})) {
    // Why: corrupt non-object entries are dropped later by the worktreeMeta normalizer.
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      continue
    }
    if (!('collectionIds' in meta)) {
      continue
    }
    const raw: unknown = meta.collectionIds
    normalizeMembership(meta, live)
    const next = meta.collectionIds
    // Why: any delta (dropped key, dedupe, reorder at equal length) must persist or it recurs.
    if (
      !Array.isArray(raw) ||
      next?.length !== raw.length ||
      !next.every((id, index) => id === raw[index])
    ) {
      changed = true
    }
  }
  return changed
}
