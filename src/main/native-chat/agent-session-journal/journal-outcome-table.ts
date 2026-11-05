import type { JournalReadConnection } from './journal-sql-owner'
import { prepareJournalAcceptance } from './journal-input-provenance'
import {
  restoreJournalNativeFacts,
  detachJournalNativePrefix,
  restoreJournalNativeState
} from './journal-input-conversion'
import { readLegacyRowsAsync, journalLegacyCardsFromRows } from './journal-queue-import'

import type Database from '../../sqlite/sync-database'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { JournalOutcomeFold } from './journal-outcome-codec'
import type { JournalOutcomeSource } from './journal-outcome-format'
import { planJournalOutcomeRows, type PlannedJournalOutcome } from './journal-outcome-plan'

import {
  JOURNAL_NEWEST_OUTCOME_SQL,
  writeJournalEncodedOutcomes
} from './journal-outcome-persistence'
export { JOURNAL_NEWEST_OUTCOME_SQL } from './journal-outcome-persistence'

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
  const recoveries = [...(baseline?.queue.cards.values() ?? [])].flatMap((card) =>
    card.recovers ? [{ id: card.messageId, recovers: card.recovers }] : []
  )
  const prefix = detachJournalNativePrefix(baseline)
  const fold = new JournalOutcomeFold()
  let after = { field: '', key: '' }
  for (;;) {
    const row = newest.get(source.generation, after.field, after.key, source.through)
    if (!row) {
      const state = fold.finish(sessionId, epoch, source.through, baseline)
      // Tail values omit derived recovery links; only the same raw-prefix incarnation inherits one.
      for (const { id, recovers } of recoveries) {
        const card = state.queue.cards.get(id)
        if (card && !fold.replaced('queue.cards', id)) {
          card.recovers = recovers
        }
      }
      restoreJournalNativeState(db, state, source.format, fold, prefix)
      return state
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
  savedAt?: number,
  upgradeNative = false,
  finish?: (state: JournalReducerState) => void
): { state: JournalReducerState; adopt: () => JournalReducerState } {
  const transition = planJournalOutcomeRows(state, rows, savedAt, upgradeNative, finish)
  writePlannedJournalOutcomes(db, source, transition.values)
  return { state: transition.state, adopt: transition.adopt }
}

/** Resolve ordinal/previous-key facts inside the storage transaction. */
export function writePlannedJournalOutcomes(
  db: Database.Database,
  source: Pick<JournalOutcomeSource, 'generation' | 'prefix'>,
  values: readonly PlannedJournalOutcome[]
): void {
  writeJournalEncodedOutcomes(db, source, values)
}

export async function readJournalOutcomesAsync(
  read: JournalReadConnection,
  sessionId: string,
  epoch: string,
  source: JournalOutcomeSource,
  baseline?: JournalReducerState
): Promise<JournalReducerState> {
  const recoveries = [...(baseline?.queue.cards.values() ?? [])].flatMap((card) =>
    card.recovers ? [{ id: card.messageId, recovers: card.recovers }] : []
  )
  const prefix = detachJournalNativePrefix(baseline)
  const fold = new JournalOutcomeFold()
  let after = { field: '', key: '' }
  for (;;) {
    const page = await read.outcomes(source.generation, source.through, after.field, after.key)
    if (page.length === 0) {
      break
    }
    for (const row of page) {
      after = fold.add(row)
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const state = fold.finish(sessionId, epoch, source.through, baseline)
  for (const { id, recovers } of recoveries) {
    const card = state.queue.cards.get(id)
    if (card && !fold.replaced('queue.cards', id)) {
      card.recovers = recovers
    }
  }
  const acceptance = await prepareJournalAcceptance(read, sessionId, [
    ...state.inputEntries.keys(),
    ...state.submissions.keys()
  ])
  const legacy = await readLegacyRowsAsync(read, sessionId)
  restoreJournalNativeFacts(state, source.format, fold, prefix, acceptance, (state) =>
    journalLegacyCardsFromRows(state, legacy)
  )
  return state
}
