import type { JournalReducerState } from '../projection/journal-reducer'
import type { JournalInputOrder } from './journal-input-order'

/** Injected so the order's own indexes resolve it without importing its module. */
export type JournalInputOrderResolver = (state: JournalReducerState) => JournalInputOrder

const owners = new WeakMap<JournalReducerState, JournalInputOrder>()
export function getJournalInputOrder(state: JournalReducerState): JournalInputOrder | undefined {
  return owners.get(state)
}
export function setJournalInputOrder(state: JournalReducerState, owner: JournalInputOrder): void {
  owners.set(state, owner)
}
