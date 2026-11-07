import Database from '../../sqlite/sync-database'
import { restoreJournal } from './replay/journal-open'
import { failLoadOnUnloadableJournal } from './replay/journal-open-failure'
import { JournalOutcomeItemProvenance } from './journal-outcome-item-provenance'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { exportJournalControlState } from './journal-sql-control-export'
import { journalInputAcceptance } from './input-order/journal-input-provenance'
import {
  beginJournalSqlConversion,
  markJournalSqlReady,
  readJournalLogWatermark,
  type JournalLogWatermark
} from './journal-sql-meta'
import { deleteJournalSqlProjectionPage } from './journal-sql-projection-sweep'

export type JournalSqlConversionTable = { name: string; columns: string[]; rows: unknown[][] }

/** A chat's restored state as typed projection rows, with the log coverage it was read at. */
export type JournalSqlConversion = {
  sessionId: string
  epoch: string
  watermark: JournalLogWatermark
  tables: JournalSqlConversionTable[]
}

/**
 * The read half of a conversion, on a reader's snapshot: today's restore reads the log exactly as
 * an open does, and its result is exported as typed rows into a private in-memory database. Items
 * the restore admitted unchanged keep pointing at their saved outcome record instead of a copy.
 * Returns null for a chat with nothing to convert; its first open founds the epoch.
 */
export function prepareJournalSqlConversion(
  db: Database.Database,
  sessionId: string
): JournalSqlConversion | null {
  if (!db.isTransaction) {
    throw new Error('journal projection conversion reads one snapshot')
  }
  const provenance = new JournalOutcomeItemProvenance()
  const loaded = restoreJournal(db, sessionId, { admitItem: provenance.capture })
  if (!loaded || (!loaded.newer && !loaded.damage && loaded.state.lastSequence === 0)) {
    return null
  }
  failLoadOnUnloadableJournal(sessionId, loaded)
  const watermark = readJournalLogWatermark(db, sessionId)
  if (watermark?.epoch !== loaded.state.epoch) {
    throw new Error('journal log changed during projection conversion')
  }
  const staging = new Database(':memory:')
  try {
    // Staged rows are only exported and copied out; the real tables carry the indexes.
    staging.exec(
      journalSqlProjectionSchema().replace(/CREATE (UNIQUE )?INDEX IF NOT EXISTS[^;]*;/g, '')
    )
    const exported = new JournalSqlReducer(
      new JournalSqlScope(staging, sessionId, watermark.epoch),
      watermark.epoch,
      (id) => journalInputAcceptance(db, sessionId, id)
    )
    staging.exec('BEGIN')
    exported.context.bulkLoad(
      () => {
        exportJournalControlState(loaded.state, exported.state, { items: true })
        exported.flush()
      },
      (item, key) => provenance.source(item, key)
    )
    staging.exec('COMMIT')
    return { sessionId, epoch: watermark.epoch, watermark, tables: stagedTables(staging) }
  } finally {
    staging.close()
  }
}

function stagedTables(staging: Database.Database): JournalSqlConversionTable[] {
  return staging
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'journal_proj_%'
    AND name <> 'journal_proj_meta' ORDER BY name`)
    .all()
    .map(({ name }) => {
      const table = String(name)
      const columns = staging
        .prepare('SELECT name FROM pragma_table_info(?) ORDER BY cid')
        .all(table)
        .map((column) => String(column.name))
      const rows = staging
        .prepare(`SELECT * FROM "${table}"`)
        .all()
        .map((row) => columns.map((column) => row[column]))
      return { name: table, columns, rows }
    })
    .filter(({ rows }) => rows.length > 0)
}

/** One writer batch of a conversion's rows; other chats' commands run between batches. */
export function insertJournalSqlConversionRows(
  db: Database.Database,
  table: Pick<JournalSqlConversionTable, 'name' | 'columns'>,
  rows: readonly unknown[][]
): void {
  const insert = db.prepare(`INSERT INTO "${table.name}" (${table.columns.join(', ')})
    VALUES (${table.columns.map(() => '?').join(', ')})`)
  for (const row of rows) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: staged values come straight from SQLite columns.
    insert.run(...(row as (string | number | null)[]))
  }
}

/** Publishes the chat ready only if its log still has the coverage the rows were read at. */
export function finishJournalSqlConversion(
  db: Database.Database,
  conversion: Pick<JournalSqlConversion, 'sessionId' | 'watermark'>
): boolean {
  const now = readJournalLogWatermark(db, conversion.sessionId)
  if (JSON.stringify(now) !== JSON.stringify(conversion.watermark)) {
    return false
  }
  markJournalSqlReady(db, conversion.sessionId)
  return true
}

/**
 * Converts one chat in one transaction, in the order a background conversion takes across writer
 * batches: read, mark converting, clear every derived row of the chat, insert, publish ready.
 */
export function convertJournalSqlProjection(
  db: Database.Database,
  sessionId: string
): string | null {
  if (!db.isTransaction) {
    throw new Error('journal projection conversion requires its transaction')
  }
  // The projection's tables exist only once a chat converts, so builds without a consumer stay dark.
  db.exec(journalSqlProjectionSchema())
  const conversion = prepareJournalSqlConversion(db, sessionId)
  if (!conversion) {
    return null
  }
  beginJournalSqlConversion(db, sessionId)
  while (deleteJournalSqlProjectionPage(db, sessionId, null, 4096)) {
    // Each page is bounded; a background conversion commits between pages.
  }
  for (const table of conversion.tables) {
    insertJournalSqlConversionRows(db, table, table.rows)
  }
  if (!finishJournalSqlConversion(db, conversion)) {
    throw new Error('journal log changed during projection conversion')
  }
  return conversion.epoch
}
