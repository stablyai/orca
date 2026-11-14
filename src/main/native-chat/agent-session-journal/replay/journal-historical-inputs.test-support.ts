import type Database from '../../../sqlite/sync-database'
import type { AgentSessionJournalIdentity } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { insertJournalRow, publishJournalSessionEpoch } from '../durable-rows/journal-row-table'
import { runJournalTransaction } from '../database/journal-database'
import { publishJournalOutcomeEpoch } from '../outcomes/journal-outcome-epoch.test-fixture'

/** Author frozen saved rows before opening the current SQL journal. */
export function seedTestJournalHistoricalRows(
  db: Database.Database,
  identity: AgentSessionJournalIdentity,
  rows: readonly JournalRow[],
  retained = false
): void {
  const first = rows[0]
  if (first?.kind !== 'epoch') {
    throw new Error('historical fixture needs its founding epoch')
  }
  runJournalTransaction(db, () => {
    publishJournalSessionEpoch(db, identity, first.epoch)
    if (retained) {
      publishJournalOutcomeEpoch(db, identity.sessionId, first.epoch, rows)
    } else {
      for (const row of rows) {
        insertJournalRow(db, identity.sessionId, row)
      }
    }
  })
}
