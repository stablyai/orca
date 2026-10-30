import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import { applyJournalRow } from './journal-reducer'
import { isolateJournalTransition } from './journal-reducer-transition'
import type { JournalRow } from './journal-row-schema'
import { journalRowReadBack } from './journal-row-table'
import {
  decodeJournalOutcome,
  encodeJournalOutcomes,
  journalOutcomeScalars,
  JournalOutcomeFold,
  type JournalOutcome
} from './journal-outcome-codec'

export const JOURNAL_OUTCOME_PAGE_ROWS = 32
export const JOURNAL_OUTCOME_PAGE_BYTES = 1 << 20
export type JournalOutcomePosition = { seq: number; field: string; key: string }
export const JOURNAL_OUTCOME_START: JournalOutcomePosition = { seq: 0, field: '', key: '' }

export function readJournalOutcomePage(
  db: Database.Database,
  generation: number,
  after: JournalOutcomePosition,
  through: number,
  limit = JOURNAL_OUTCOME_PAGE_ROWS
): JournalOutcome[] {
  const values: JournalOutcome[] = []
  let bytes = 0
  for (const row of db
    .prepare(`SELECT seq, field, entry_key, ordinal, value_json, deleted
    FROM journal_outcomes WHERE generation = ?
    AND (seq, field, entry_key) > (?, ?, ?) AND seq <= ?
    ORDER BY seq, field, entry_key LIMIT ?`)
    .iterate(generation, after.seq, after.field, after.key, through, limit)) {
    values.push(decodeJournalOutcome(row))
    bytes += typeof row.value_json === 'string' ? Buffer.byteLength(row.value_json) : 0
    if (bytes >= JOURNAL_OUTCOME_PAGE_BYTES) {
      break
    }
  }
  return values
}

export function rebuildJournalOutcomes(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  generation: number,
  through: number
): JournalReducerState {
  const pages = rebuildJournalOutcomePages(() => db, sessionId, epoch, generation, through)
  let step = pages.next()
  while (!step.done) {
    step = pages.next()
  }
  return step.value
}

export function* rebuildJournalOutcomePages(
  database: () => Database.Database,
  sessionId: string,
  epoch: string,
  generation: number,
  through: number
): Generator<void, JournalReducerState> {
  const fold = new JournalOutcomeFold()
  let after = JOURNAL_OUTCOME_START
  for (;;) {
    const values = readJournalOutcomePage(database(), generation, after, through)
    const last = values.at(-1)
    if (!last) {
      return yield* fold.finishPages(sessionId, epoch, through)
    }
    for (const value of values) {
      fold.add(value)
    }
    after = { seq: last.seq, field: last.field, key: last.key }
    yield
  }
}

/** Runs inside the receipt transaction. Staging keeps only the latest contribution per key. A row
 * the reader would reject is refused, as an input insert refuses it; the caller rolls back. */
export function persistJournalOutcomeRows(
  db: Database.Database,
  state: JournalReducerState,
  generation: number,
  rows: readonly JournalRow[],
  savedAt?: number | ((row: JournalRow) => number),
  compact = false
): { state: JournalReducerState; values: JournalOutcome[]; adopt: () => JournalReducerState } {
  const values: JournalOutcome[] = []
  let scalar = state.lastSequence === 0 ? {} : journalOutcomeScalars(state)
  const transition = isolateJournalTransition(state, () => undefined)
  const previous = db.prepare(`SELECT ordinal, deleted FROM journal_outcomes
    WHERE generation = ? AND field = ? AND entry_key = ? ORDER BY seq DESC LIMIT 1`)
  for (const row of rows) {
    journalRowReadBack(state.sessionId, row)
    applyJournalRow(
      transition.state,
      row,
      typeof savedAt === 'function' ? savedAt(row) : (savedAt ?? row.ts)
    )
    const changes = transition.changes(true)
    const encoded = encodeJournalOutcomes(transition.state, changes, scalar)
    scalar = encoded.scalars
    for (const [index, value] of encoded.values.entries()) {
      const change = changes.find(
        (entry) => entry.path === value.field && JSON.stringify(entry.key) === value.key
      )
      const kept = previous.get(generation, value.field, value.key)
      // A new or re-created key takes its place in the row's touch order, as the live map does.
      const ordinal =
        !change?.reinsert && kept?.deleted === 0 && typeof kept.ordinal === 'string'
          ? kept.ordinal
          : `s${String(row.seq).padStart(16, '0')}:${String(index).padStart(16, '0')}`
      if (compact) {
        db.prepare(`DELETE FROM journal_outcomes
          WHERE generation = ? AND field = ? AND entry_key = ?`).run(
          generation,
          value.field,
          value.key
        )
      }
      db.prepare(`INSERT INTO journal_outcomes
        (generation, seq, field, entry_key, ordinal, value_json, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        generation,
        value.seq,
        value.field,
        value.key,
        ordinal,
        value.json,
        Number(value.deleted)
      )
      values.push({ ...value, ordinal })
    }
  }
  return { state: transition.state, values, adopt: transition.adopt }
}
