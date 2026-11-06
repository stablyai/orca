import type Database from '../../sqlite/sync-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql
} from './journal-database-schema'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { publishJournalSessionEpoch } from './journal-row-table'
import {
  advanceJournalOutcomeSource,
  ensureJournalOutcomeTables,
  startJournalOutcomeLog
} from './journal-outcome-format'
import { persistJournalOutcomeTransition } from './journal-outcome-table'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { journalInputOrder } from './journal-input-order'
import { ensureCommandReceiptsTable } from './command-receipt-schema'
import { ensureQueuedMessagesTable } from './queued-message-schema'

/** Seeds a published projection without pretending to exercise actual-open reconstruction. */
export function seedJournalSqlCommands(db: Database.Database) {
  db.exec(
    createJournalTablesSql() + createAgentSessionRecordTablesSql() + journalSqlProjectionSchema()
  )
  ensureJournalOutcomeTables(db)
  ensureCommandReceiptsTable(db)
  ensureQueuedMessagesTable(db)
  publishJournalSessionEpoch(db, { sessionId: 'session', workspaceId: 'workspace' }, 'epoch')
  const source = startJournalOutcomeLog(db, 'session', 'epoch', 0, 100)
  const initial = journalSqlLifecycleRows()[0]!
  const scope = new JournalSqlScope(db, 'session', 'projection')
  persistJournalOutcomeTransition(
    db,
    new JournalSqlReducer(scope, 'epoch').transition(),
    source,
    [initial],
    100,
    true,
    (state) => journalInputOrder(state).cards.ensure(state)
  )
  advanceJournalOutcomeSource(db, 'session', 'epoch', 1)
  db.prepare('INSERT INTO journal_proj_meta VALUES (?, ?, ?, ?, ?)').run(
    'session',
    'epoch',
    'projection',
    1,
    'open-token'
  )
  return { source, initial }
}
