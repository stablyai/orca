import type { AgentJournalCursor } from '../../../shared/agent-session-journal-identity'
import type { JournalReducerState } from './journal-reducer'
import { JournalInputOrder } from './journal-input-order'

const owners = new WeakMap<JournalReducerState, JournalInputOrder>()
export function initializeJournalInputOrder(
  state: JournalReducerState,
  originalAcceptance?: (id: string) => AgentJournalCursor | undefined
): JournalInputOrder {
  const owner = new JournalInputOrder(state, originalAcceptance)
  owners.set(state, owner)
  return owner
}
export function journalInputOrder(state: JournalReducerState): JournalInputOrder {
  return owners.get(state) ?? initializeJournalInputOrder(state)
}
export function setJournalInputOrder(state: JournalReducerState, owner: JournalInputOrder): void {
  owners.set(state, owner)
}
