import type { AgentSessionRecord } from '../../../shared/agent-session-record'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

/** Proof a chat started here has sent nothing, so the default it shows is the one its first send
 *  pins. When unsure (history it was taken from, any turn even before a context clear, a rewind,
 *  or a journal founded afresh for a chat whose agent already ran), it has sent. */
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
