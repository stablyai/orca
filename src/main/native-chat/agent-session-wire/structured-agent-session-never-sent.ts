import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** Prove local unsent history; adoption, prior turns, rewind or a replacement journal defeat proof. */
export function structuredAgentSessionNeverSent(
  record: AgentSessionRecord | null,
  journal: Pick<AgentSessionJournal, 'submissions' | 'visitItems' | 'wroteBeforeOpen'>
): boolean {
  if (
    !record ||
    record.providerHandleChain[0]?.origin === 'adopted' ||
    record.rewind !== undefined ||
    journal.submissions().length > 0 ||
    (record.providerHandleChain.length > 0 && !journal.wroteBeforeOpen(1))
  ) {
    return false
  }
  let turned = false
  journal.visitItems((_itemId, _sequence, body) => {
    turned ||= readAgentJournalTurn(body) !== null
  })
  return !turned
}
