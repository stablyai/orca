type WorktreeSortOrderStore = {
  getWorktreeMeta: (worktreeId: string) => { sortOrder?: number } | undefined
  setWorktreeMeta: (worktreeId: string, updates: { sortOrder: number }) => unknown
}

type PersistedSortOrderEntry = {
  id: string
  sortOrder: number | undefined
}

function alreadyPersistsOrder(entries: readonly PersistedSortOrderEntry[]): boolean {
  if (entries.length < 2) {
    return true
  }
  return entries.every(
    (entry, index) => index === 0 || entries[index - 1]!.sortOrder! > entry.sortOrder!
  )
}

export function persistWorktreeSortOrderSnapshot(
  store: WorktreeSortOrderStore,
  orderedIds: readonly string[],
  now = Date.now()
): number {
  const entries = orderedIds.flatMap((id): PersistedSortOrderEntry[] => {
    const meta = store.getWorktreeMeta(id)
    return meta ? [{ id, sortOrder: meta.sortOrder }] : []
  })
  if (alreadyPersistsOrder(entries)) {
    return 0
  }
  for (let index = 0; index < entries.length; index++) {
    store.setWorktreeMeta(entries[index]!.id, { sortOrder: now - index * 1000 })
  }
  return entries.length
}
