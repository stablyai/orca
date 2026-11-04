import type { JournalReducerState } from './journal-reducer'

export function nextJournalItemRevision(
  state: JournalReducerState,
  itemId: string,
  revisions?: Map<string, number>
): number {
  const revision =
    (revisions?.get(itemId) ??
      Math.max(state.items.get(itemId)?.revision ?? 0, state.tombstones.get(itemId) ?? 0)) + 1
  revisions?.set(itemId, revision)
  return revision
}

export function journalItemRevisionIsStale(
  state: JournalReducerState,
  itemId: string,
  revision: number
): boolean {
  const tombstoned = state.tombstones.get(itemId)
  const existing = state.items.get(itemId)
  return (
    (tombstoned !== undefined && revision <= tombstoned) ||
    (existing !== undefined && revision <= existing.revision)
  )
}
