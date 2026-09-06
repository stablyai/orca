import type { PersistedState } from '../../../shared/persisted-state-types'
import { normalizeCollectionIds, pruneMissingCollectionIds } from '../../../shared/collections'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'

/**
 * Why: single chokepoint for every membership writer (IPC updateMeta, worktree.set RPC,
 * setWorktreeCollectionIds) — dedupe, drop ids whose collection is gone, and collapse an
 * empty result to "key absent" so `[]` is never persisted.
 */
export function normalizeWrittenCollectionIds(state: PersistedState, updated: WorktreeMeta): void {
  if (!('collectionIds' in updated)) {
    return
  }
  const pruned = pruneMissingCollectionIds(
    normalizeCollectionIds(updated.collectionIds),
    new Set((state.collections ?? []).map((entry) => entry.id))
  )
  if (pruned) {
    updated.collectionIds = pruned
  } else {
    delete updated.collectionIds
  }
}

/**
 * Drops memberships whose collection is gone. Returns whether the loaded state changed,
 * so the caller can mark the profile for rewrite.
 */
export function pruneLoadedCollectionMemberships(state: PersistedState): boolean {
  const collectionIdSet = new Set((state.collections ?? []).map((collection) => collection.id))
  let changed = false
  for (const meta of Object.values(state.worktreeMeta ?? {})) {
    // Why: corrupt non-object entries are dropped later by the worktreeMeta normalizer.
    if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) {
      continue
    }
    if (!('collectionIds' in meta)) {
      continue
    }
    const raw = meta.collectionIds
    const pruned = pruneMissingCollectionIds(normalizeCollectionIds(raw), collectionIdSet)
    if (pruned) {
      // Why: dedupe/prune reordering counts as a change even at equal length.
      const unchanged =
        Array.isArray(raw) &&
        pruned.length === raw.length &&
        pruned.every((id, index) => id === raw[index])
      if (!unchanged) {
        changed = true
      }
      meta.collectionIds = pruned
    } else {
      // Why: the key existed with nothing valid ([], dupes-only, garbage) —
      // deleting it must persist or the stray field survives every restart.
      changed = true
      delete meta.collectionIds
    }
  }
  return changed
}
