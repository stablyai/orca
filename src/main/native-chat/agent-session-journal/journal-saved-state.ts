import type Database from '../../sqlite/sync-database'
import type { SqliteBindings, SqliteRow, SqliteStatement } from '../../sqlite/sqlite-statement'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import { startJournalStateDecode } from './journal-state-codec'
import { clearJournalSavedState, publishJournalProjection } from './journal-projection-table'

export { ensureJournalSavedStateTables, clearJournalSavedState } from './journal-projection-table'

/** The saved row a projection delta is computed from; null when the chat has none. */
export type JournalSavedStamp = { epoch: string; through: number; version: number } | null

export function readJournalSavedStamp(db: Database.Database, sessionId: string): JournalSavedStamp {
  const row = db
    .prepare('SELECT epoch, through_seq, version FROM journal_state WHERE session_id = ?')
    .get(sessionId)
  return row &&
    typeof row.epoch === 'string' &&
    typeof row.through_seq === 'number' &&
    typeof row.version === 'number'
    ? { epoch: row.epoch, through: row.through_seq, version: row.version }
    : null
}

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

/** Rows per page and the stored text (UTF-16 units) after which a page stops; at least one row. */
export type JournalSavedPage = { rows: number; chars: number }

/** Decodes the view in storage-order pages, yielding between them; the default reads each table at
 * once. Content this codec rejects is unreadable; storage errors throw, so they are never absent. */
export function* readJournalSavedStatePages(
  database: () => Database.Database,
  sessionId: string,
  epoch: string,
  page: JournalSavedPage = { rows: -1, chars: Number.POSITIVE_INFINITY }
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
  let ordinal = -1
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
        if (typeof item.ordinal !== 'number' || typeof item.item_json !== 'string') {
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
          typeof entry.ordinal !== 'number' ||
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
  let chars = 0
  for (const row of statement.iterate(...parameters, page.rows)) {
    rows.push(row)
    const text = row[column]
    chars += typeof text === 'string' ? text.length : 0
    if (chars >= page.chars) {
      return { rows, more: true }
    }
  }
  return { rows, more: page.rows >= 0 && rows.length === page.rows }
}

/** Items and entries are written only beside their session's state row, so orphans are found from
 * one row per chat; the deletes use each session's key prefix. */
export function sweepJournalSavedState(database: JournalHostDatabase): void {
  database.transaction((db) => {
    const orphans = db
      .prepare(`SELECT c.session_id FROM journal_state c
      LEFT JOIN journal_sessions s ON s.session_id = c.session_id AND s.epoch = c.epoch
      WHERE s.session_id IS NULL`)
      .all()
    for (const { session_id: sessionId } of orphans) {
      if (typeof sessionId === 'string') {
        clearJournalSavedState(db, sessionId)
      }
    }
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

/** Epoch publishers write the new epoch's saved state with its rows; returns the coverage. */
export function publishJournalEpochState(
  db: Database.Database,
  state: JournalReducerState
): number {
  return writeJournalProjectionSavepoint(db, state.sessionId, () =>
    publishJournalProjection(db, state)
  )
    ? state.lastSequence
    : 0
}

export function logJournalProjectionFailure(sessionId: string, error: unknown): void {
  console.warn('[agent-session-journal] could not save chat state', { sessionId, error })
}

/** Mobile test programs type global timers as numbers; Node timers may release the event loop. */
export function unrefJournalProjectionTimer(timer: unknown): void {
  if (typeof timer === 'object' && timer && 'unref' in timer && typeof timer.unref === 'function') {
    timer.unref()
  }
}
