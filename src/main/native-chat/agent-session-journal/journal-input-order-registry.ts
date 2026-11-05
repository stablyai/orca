import type { JournalReducerState } from './journal-reducer'
import { JournalInputOrder } from './journal-input-order'
import type { JournalIndexStorageFactory } from './journal-index-storage'
import { memoryJournalIndexStorage } from './journal-memory-index-storage'

const owners = new WeakMap<JournalReducerState, JournalInputOrder>()
export function getJournalInputOrder(state: JournalReducerState): JournalInputOrder | undefined {
  return owners.get(state)
}
export function setJournalInputOrder(state: JournalReducerState, owner: JournalInputOrder): void {
  owners.set(state, owner)
}

export function initializeJournalInputOrder(
  state: JournalReducerState,
  originalAcceptance?: ConstructorParameters<typeof JournalInputOrder>[1],
  storage: JournalIndexStorageFactory = memoryJournalIndexStorage
): JournalInputOrder {
  const owner = new JournalInputOrder(state, originalAcceptance, undefined, storage)
  setJournalInputOrder(state, owner)
  return owner
}

export function journalInputOrder(state: JournalReducerState): JournalInputOrder {
  return getJournalInputOrder(state) ?? initializeJournalInputOrder(state)
}
