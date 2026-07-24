import type { WorktreeMeta } from '../shared/types'

type WorktreeSortOrderReader = {
  getWorktreeMeta(worktreeId: string): WorktreeMeta | undefined
  setWorktreeMeta(worktreeId: string, meta: Partial<WorktreeMeta>): WorktreeMeta
}

function worktreeSortOrderNeedsPersistence(
  store: WorktreeSortOrderReader,
  orderedIds: readonly string[]
): boolean {
  let previousSortOrder = Number.POSITIVE_INFINITY
  const seen = new Set<string>()
  for (const worktreeId of orderedIds) {
    if (seen.has(worktreeId)) {
      return true
    }
    seen.add(worktreeId)
    // Why: never mint meta for unknown ids (#9342); only evaluate existing entries.
    const meta = store.getWorktreeMeta(worktreeId)
    if (!meta) {
      continue
    }
    const sortOrder = meta.sortOrder
    // Why: persisted ranks are strictly descending. Missing, invalid, or tied
    // ranks cannot reliably restore the renderer's requested relative order.
    if (
      typeof sortOrder !== 'number' ||
      !Number.isFinite(sortOrder) ||
      sortOrder >= previousSortOrder
    ) {
      return true
    }
    previousSortOrder = sortOrder
  }
  return false
}

/** Persists a changed worktree order and returns the number of updated entries. */
export function persistWorktreeSortOrder(
  store: WorktreeSortOrderReader,
  orderedIds: readonly string[],
  now = Date.now()
): number {
  if (!worktreeSortOrderNeedsPersistence(store, orderedIds)) {
    return 0
  }
  let updated = 0
  for (let index = 0; index < orderedIds.length; index++) {
    const worktreeId = orderedIds[index]!
    // Why: a sort-order snapshot must only reorder existing worktrees, never
    // mint new meta (#9342).
    if (!store.getWorktreeMeta(worktreeId)) {
      continue
    }
    store.setWorktreeMeta(worktreeId, { sortOrder: now - index * 1000 })
    updated += 1
  }
  return updated
}
