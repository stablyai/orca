import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOwnedItem } from './journal-execution-interruption'

/** Retaining an execution does not restore its displaced public slot. */
export function isPublicJournalExecution(
  state: Pick<JournalReducerState, 'aliases'>,
  item: JournalOwnedItem
): boolean {
  return (
    !readAgentJournalTurn(item.body) ||
    (state.aliases.get(item.itemId) ?? item.itemId) === item.itemId
  )
}
