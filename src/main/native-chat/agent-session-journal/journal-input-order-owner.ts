import { JournalInputOrder } from './journal-input-order'
import type { JournalReducerState } from './journal-reducer'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { JournalNewestTurn } from './journal-newest-turn'
import { finishJournalSteps } from './journal-reconstruction-steps'

import { getJournalInputOrder, setJournalInputOrder } from './journal-input-order-registry'
export { setJournalInputOrder } from './journal-input-order-registry'
export function initializeJournalInputOrder(
  state: JournalReducerState,
  originalAcceptance?: (id: string) => AgentJournalCursor | undefined
): JournalInputOrder {
  return finishJournalSteps(initializeJournalInputOrderSteps(state, originalAcceptance))
}
export function* initializeJournalInputOrderSteps(
  state: JournalReducerState,
  originalAcceptance?: (id: string) => AgentJournalCursor | undefined
): Generator<void, JournalInputOrder> {
  const newest = yield* JournalNewestTurn.createSteps(state)
  const owner = new JournalInputOrder(state, originalAcceptance, newest)
  setJournalInputOrder(state, owner)
  return owner
}
export function journalInputOrder(state: JournalReducerState): JournalInputOrder {
  return getJournalInputOrder(state) ?? initializeJournalInputOrder(state)
}
