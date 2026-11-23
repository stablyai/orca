import type Database from '../../sqlite/sync-database'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import type { JournalDomainHistoryHead } from './journal-domain-history-page'

/** The chat's journal head as one history frame reads it. */
export function readJournalDomainHistoryHead(
  db: Database.Database,
  sessionId: string
): JournalDomainHistoryHead {
  const row = db
    .prepare(`SELECT epoch, last_sequence, retained_sequence, context_boundary FROM journal_chat_state
    WHERE session_id=? AND epoch IS NOT NULL`)
    .get(sessionId)
  if (!row) {
    throw new Error('journal history targets a chat without domain state')
  }
  const epoch = String(row.epoch)
  return {
    sessionId,
    epoch,
    cursor: {
      epoch: journalContextEpoch(epoch, Number(row.context_boundary)),
      sequence: Number(row.last_sequence)
    },
    retainedSequence: Number(row.retained_sequence)
  }
}
