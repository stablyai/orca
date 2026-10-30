import type Database from '../../sqlite/sync-database'
import type { SqliteBindings, SqliteRow, SqliteStatement } from '../../sqlite/sqlite-statement'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import { startJournalStateDecode } from './journal-state-codec'

export { ensureJournalSavedStateTables, clearJournalSavedState } from './journal-projection-table'

export function readJournalSavedState(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalReducerState | null {
  try {
    const pages = readJournalSavedStatePages(() => db, sessionId, epoch)
    let step = pages.next()
    while (!step.done) {
      step = pages.next()
    }
    return typeof step.value === 'string' ? null : step.value
  } catch (error) {
    logJournalProjectionFailure(sessionId, error)
    return null
  }
}

/** A decoded view, none for this epoch, or a present view this build cannot read. */
export type JournalSavedView = JournalReducerState | 'absent' | 'unreadable'

/** Rows per page and the stored UTF-8 bytes after which a page stops; at least one row. */
export type JournalSavedPage = { rows: number; bytes: number }

/** Decodes the view in storage-order pages, yielding between them; the default reads each table at
 * once. Content this codec rejects is unreadable; storage errors throw, so they are never absent. */
export function* readJournalSavedStatePages(
  database: () => Database.Database,
  sessionId: string,
  epoch: string,
  page: JournalSavedPage = { rows: -1, bytes: Number.POSITIVE_INFINITY }
): Generator<void, JournalSavedView> {
  const row = database()
    .prepare(`SELECT through_seq, version, state_json FROM journal_state
    WHERE session_id = ? AND epoch = ?`)
    .get(sessionId, epoch)
  if (!row) {
    return 'absent'
  }
  const decode = decoding(sessionId, () => {
    if (typeof row.version !== 'number' || typeof row.state_json !== 'string') {
      throw new Error('invalid saved journal state')
    }
    return startJournalStateDecode(row.version, row.state_json) ?? 'unreadable'
  })
  if (decode === 'unreadable') {
    return 'unreadable'
  }
  let ordinal: number | string = -1
  for (let more = true; more;) {
    const items = readTextPage(
      database().prepare(`SELECT ordinal, item_json FROM journal_items
      WHERE session_id = ? AND epoch = ? AND ordinal > ? ORDER BY ordinal LIMIT ?`),
      [sessionId, epoch, ordinal],
      'item_json',
      page
    )
    for (const item of items.rows) {
      const next = decoding(sessionId, () => {
        if (
          (typeof item.ordinal !== 'number' && typeof item.ordinal !== 'string') ||
          typeof item.item_json !== 'string'
        ) {
          throw new Error('invalid saved journal item')
        }
        decode.item(item.item_json)
        return item.ordinal
      })
      if (next === 'unreadable') {
        return 'unreadable'
      }
      ordinal = next
    }
    more = items.more
    if (more) {
      yield
    }
  }
  let field = ''
  ordinal = -1
  for (let more = true; more;) {
    const entries = readTextPage(
      database().prepare(`SELECT field, ordinal, entry_json FROM journal_entries
      WHERE session_id = ? AND epoch = ? AND (field, ordinal) > (?, ?)
      ORDER BY field, ordinal LIMIT ?`),
      [sessionId, epoch, field, ordinal],
      'entry_json',
      page
    )
    for (const entry of entries.rows) {
      const next = decoding(sessionId, () => {
        if (
          typeof entry.field !== 'string' ||
          (typeof entry.ordinal !== 'number' && typeof entry.ordinal !== 'string') ||
          typeof entry.entry_json !== 'string'
        ) {
          throw new Error('invalid saved journal entry')
        }
        decode.entry(entry.field, entry.entry_json)
        return { field: entry.field, ordinal: entry.ordinal }
      })
      if (next === 'unreadable') {
        return 'unreadable'
      }
      field = next.field
      ordinal = next.ordinal
    }
    more = entries.more
    if (more) {
      yield
    }
  }
  return decoding(sessionId, () => {
    const state = decode.finish()
    if (
      state.sessionId !== sessionId ||
      state.epoch !== epoch ||
      state.lastSequence !== row.through_seq
    ) {
      throw new Error('invalid saved journal coverage')
    }
    return state
  })
}

/** Content the codec rejects marks the view unreadable; storage errors propagate. */
function decoding<T>(sessionId: string, decode: () => T): T | 'unreadable' {
  try {
    return decode()
  } catch (error) {
    logJournalProjectionFailure(sessionId, error)
    return 'unreadable'
  }
}

/** The cursor stops after the row whose `column` text reaches the page's budget. */
function readTextPage(
  statement: SqliteStatement,
  parameters: SqliteBindings,
  column: string,
  page: JournalSavedPage
): { rows: SqliteRow[]; more: boolean } {
  const rows: SqliteRow[] = []
  let bytes = 0
  for (const row of statement.iterate(...parameters, page.rows)) {
    rows.push(row)
    const text = row[column]
    bytes += typeof text === 'string' ? Buffer.byteLength(text) : 0
    if (bytes >= page.bytes) {
      return { rows, more: true }
    }
  }
  return { rows, more: page.rows >= 0 && rows.length === page.rows }
}

/** Old epochs leave only disposable rows; retire one bounded page between maintenance rests. */
export function sweepJournalSavedState(database: JournalHostDatabase): boolean {
  return database.transaction((db) => {
    for (const table of [
      'journal_items',
      'journal_entries',
      'journal_cache_stamp',
      'journal_state'
    ]) {
      const removed = db
        .prepare(`DELETE FROM ${table} WHERE rowid IN (
        SELECT c.rowid FROM ${table} c LEFT JOIN journal_sessions s
        ON s.session_id = c.session_id AND s.epoch = c.epoch
        WHERE s.session_id IS NULL LIMIT 32)`)
        .run()
      if (removed.changes > 0) {
        return true
      }
    }
    return false
  })
}

/** Only statement-local failures can keep the outer write; an aborted transaction still throws. */
export function writeJournalProjectionSavepoint(
  db: Database.Database,
  sessionId: string,
  write: () => void
): boolean {
  db.exec('SAVEPOINT journal_projection')
  try {
    write()
  } catch (error) {
    if (!db.isTransaction) {
      throw error
    }
    db.exec('ROLLBACK TO journal_projection')
    db.exec('RELEASE journal_projection')
    if (!db.isTransaction) {
      throw error
    }
    logJournalProjectionFailure(sessionId, error)
    return false
  }
  db.exec('RELEASE journal_projection')
  return true
}

export function logJournalProjectionFailure(sessionId: string, error: unknown): void {
  try {
    console.warn('[agent-session-journal] could not save chat state', { sessionId, error })
  } catch {
    // Diagnostics cannot turn recovered cache failures into rejected sends.
  }
}

/** Mobile test programs type global timers as numbers; Node timers may release the event loop. */
export function unrefJournalProjectionTimer(timer: unknown): void {
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
}
