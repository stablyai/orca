import type { JournalReducerState } from './journal-reducer'
import type { JournalInputOrder } from './journal-input-order'

const owners = new WeakMap<JournalReducerState, JournalInputOrder>()
export function getJournalInputOrder(state: JournalReducerState): JournalInputOrder | undefined {
  return owners.get(state)
}
export function setJournalInputOrder(state: JournalReducerState, owner: JournalInputOrder): void {
  owners.set(state, owner)
}
