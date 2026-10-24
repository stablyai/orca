import type { JournalReducerState } from './journal-reducer'
import { journalTextFields } from './journal-text-rows'

export function journalHasUnwitnessedText(state: JournalReducerState, itemId: string): boolean {
  const body = state.items.get(itemId)?.body
  return (
    body !== undefined &&
    journalTextFields(body).some((field) => state.textIndex.unwitnessed(itemId, field))
  )
}
