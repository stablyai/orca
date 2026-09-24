import type { JournalReducerState } from './journal-reducer'

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
