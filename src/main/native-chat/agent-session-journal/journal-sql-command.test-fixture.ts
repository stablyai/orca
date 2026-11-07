import type Database from '../../sqlite/sync-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql
} from './database/journal-database-schema'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { beginJournalSqlConversion, markJournalSqlReady } from './journal-sql-meta'
import { publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import {
  advanceJournalOutcomeSource,
  ensureJournalOutcomeTables,
  startJournalOutcomeLog
} from './outcomes/journal-outcome-format'
import { persistJournalOutcomeTransition } from './outcomes/journal-outcome-table'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { journalInputOrder } from './input-order/journal-input-order'
import { ensureCommandReceiptsTable } from './writing/command-receipt-schema'
import { ensureQueuedMessagesTable } from './queued-messages/queued-message-schema'

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
  const scope = new JournalSqlScope(db, 'session', 'epoch')
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
  beginJournalSqlConversion(db, 'session')
  markJournalSqlReady(db, 'session')
  db.prepare(`UPDATE journal_proj_meta SET owner_token='open-token'`).run()
  return { source, initial }
}
