type WorktreeSortOrderStore = {
  getWorktreeMeta(worktreeId: string): { sortOrder: number } | undefined
  setWorktreeMeta(worktreeId: string, meta: { sortOrder: number }): unknown
}

function hasPersistedWorktreeSortOrder(
  store: WorktreeSortOrderStore,
  orderedIds: readonly string[]
): boolean {
  let previous = Number.POSITIVE_INFINITY
  for (const id of orderedIds) {
    const current = store.getWorktreeMeta(id)?.sortOrder
    // Why: timestamp gaps are a write format; idempotency only requires relative order.
    if (typeof current !== 'number' || !Number.isFinite(current) || current >= previous) {
      return false
    }
    previous = current
  }
  return true
}

export function persistWorktreeSortOrderIfChanged(
  store: WorktreeSortOrderStore,
  orderedIds: readonly string[],
  now = Date.now()
): { updated: number } {
  if (orderedIds.length === 0 || hasPersistedWorktreeSortOrder(store, orderedIds)) {
    return { updated: 0 }
  }
  for (let index = 0; index < orderedIds.length; index += 1) {
    store.setWorktreeMeta(orderedIds[index], { sortOrder: now - index * 1000 })
  }
  return { updated: orderedIds.length }
}
