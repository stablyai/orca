import type Database from '../../sqlite/sync-database'
import type { JournalHostDatabase } from './journal-host-database'
import type { JournalReducerState } from './journal-reducer'
import { startJournalStateDecode } from './journal-state-codec'

export { ensureJournalSavedStateTables, clearJournalSavedState } from './journal-projection-table'

/** A decoded view, none for this epoch, or a present view this build cannot read. */
export type JournalSavedView = JournalReducerState | 'absent' | 'unreadable'

/** Decodes the whole view in storage order in one synchronous read, like main's replay, so no
 * rebuild interleaves with it. Content this codec rejects is unreadable; storage errors throw. */
export function readJournalSavedView(
  db: Database.Database,
  sessionId: string,
  epoch: string
): JournalSavedView {
  const row = db
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
  for (const item of db
    .prepare(`SELECT item_json FROM journal_items
    WHERE session_id = ? AND epoch = ? ORDER BY ordinal`)
    .iterate(sessionId, epoch)) {
    const json = item.item_json
    if (
      decoding(sessionId, () => decode.item(typeof json === 'string' ? json : '')) === 'unreadable'
    ) {
      return 'unreadable'
    }
  }
  for (const entry of db
    .prepare(`SELECT field, entry_json FROM journal_entries
    WHERE session_id = ? AND epoch = ? ORDER BY field, ordinal`)
    .iterate(sessionId, epoch)) {
    const { field, entry_json: json } = entry
    const decoded = decoding(sessionId, () =>
      decode.entry(String(field), typeof json === 'string' ? json : '')
    )
    if (decoded === 'unreadable') {
      return 'unreadable'
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

/** Old epochs leave only disposable rows. Driven by the one journal_state row each cached chat
 * keeps, then that chat's rows by indexed prefix: one bounded page per transaction, and a pass with
 * nothing to retire reads only journal_state. */
export function sweepJournalSavedState(database: JournalHostDatabase): boolean {
  return database.transaction((db) => {
    const orphan = db
      .prepare(`SELECT c.session_id, c.epoch FROM journal_state c
      LEFT JOIN journal_sessions s ON s.session_id = c.session_id AND s.epoch = c.epoch
      WHERE s.session_id IS NULL LIMIT 1`)
      .get()
    if (typeof orphan?.session_id !== 'string' || typeof orphan.epoch !== 'string') {
      return false
    }
    for (const table of ['journal_items', 'journal_entries']) {
      const removed = db
        .prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table}
        WHERE session_id = ? AND epoch = ? LIMIT 32)`)
        .run(orphan.session_id, orphan.epoch)
      if (removed.changes > 0) {
        return true
      }
    }
    db.prepare('DELETE FROM journal_state WHERE session_id = ? AND epoch = ?').run(
      orphan.session_id,
      orphan.epoch
    )
    return true
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
