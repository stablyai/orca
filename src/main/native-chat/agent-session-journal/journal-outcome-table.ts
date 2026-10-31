import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import { applyJournalRow } from './journal-reducer'
import { isolateJournalTransition } from './journal-reducer-transition'
import type { JournalRow } from './journal-row-schema'
import { journalRowReadBack } from './journal-row-table'
import {
  encodeJournalOutcomes,
  journalOutcomeScalars,
  JournalOutcomeFold,
  JOURNAL_PREFIX_ORDINAL
} from './journal-outcome-codec'
import type { JournalOutcomeSource } from './journal-outcome-format'

// The key index orders each key's records newest first, so a range seek past the last key read lands
// on the next key's newest record: one indexed seek per key, whatever its revisions number.
export const JOURNAL_NEWEST_OUTCOME_SQL = `SELECT seq, field, entry_key, format, ordinal, value_json,
  deleted FROM journal_outcomes WHERE generation = ? AND (field, entry_key) > (?, ?) AND seq <= ?
  ORDER BY field, entry_key, seq DESC LIMIT 1`

/** Folds each key's newest record, deletions included, over `baseline`, the chat's folded input
 * prefix when it has one. Superseded revisions are never read: they no longer shape the chat. */
export function readJournalOutcomes(
  db: Database.Database,
  sessionId: string,
  epoch: string,
  source: JournalOutcomeSource,
  baseline?: JournalReducerState
): JournalReducerState {
  const newest = db.prepare(JOURNAL_NEWEST_OUTCOME_SQL)
  const fold = new JournalOutcomeFold()
  let after = { field: '', key: '' }
  for (;;) {
    const row = newest.get(source.generation, after.field, after.key, source.through)
    if (!row) {
      return fold.finish(sessionId, epoch, source.through, baseline)
    }
    const value = fold.add(row)
    after = { field: value.field, key: value.key }
  }
}

/** Runs inside the receipt transaction and only inserts: no record is ever updated or rewritten. A
 * row the reader would reject is refused, as an input insert refuses it; the caller rolls back. */
export function persistJournalOutcomeRows(
  db: Database.Database,
  state: JournalReducerState,
  source: Pick<JournalOutcomeSource, 'generation' | 'prefix'>,
  rows: readonly JournalRow[],
  savedAt?: number
): { state: JournalReducerState; adopt: () => JournalReducerState } {
  let scalar = state.lastSequence === 0 ? {} : journalOutcomeScalars(state)
  const transition = isolateJournalTransition(state, () => undefined)
  const previous = db.prepare(`SELECT ordinal, deleted FROM journal_outcomes
    WHERE generation = ? AND field = ? AND entry_key = ? ORDER BY seq DESC LIMIT 1`)
  const insert = db.prepare(`INSERT INTO journal_outcomes
    (generation, seq, field, entry_key, format, ordinal, value_json, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const row of rows) {
    // Folding what a reload reads keeps live state equal to it: an annotation the reader drops as
    // unusable never reaches the model, so it is never refused by the strict record encoder.
    const { stored } = journalRowReadBack(state.sessionId, row)
    applyJournalRow(transition.state, stored, savedAt ?? row.ts)
    const changes = transition.changes(true)
    // Only this row's own transition is recorded, never a snapshot of a prefix value it left alone.
    const encoded = encodeJournalOutcomes(transition.state, changes, scalar, transition.untracked)
    scalar = encoded.scalars
    for (const [index, value] of encoded.values.entries()) {
      // Each change's record is at its own index; the scalar records after them match no change.
      const change = changes.at(index)
      const kept = previous.get(source.generation, value.field, value.key)
      // A new or re-created key takes its place in the row's touch order, as the live map does; a
      // key that existed before this row keeps its place, which for a key only the frozen prefix
      // held is the prefix's own order.
      const ordinal = change?.reinsert
        ? appended(row.seq, index)
        : kept?.deleted === 0 && typeof kept.ordinal === 'string'
          ? kept.ordinal
          : !kept && source.prefix > 0 && change
            ? JOURNAL_PREFIX_ORDINAL
            : appended(row.seq, index)
      insert.run(
        source.generation,
        value.seq,
        value.field,
        value.key,
        value.format,
        ordinal,
        value.json,
        Number(value.deleted)
      )
    }
  }
  return { state: transition.state, adopt: transition.adopt }
}

function appended(seq: number, index: number): string {
  return `s${String(seq).padStart(16, '0')}:${String(index).padStart(16, '0')}`
}
