import type { JournalTableScope } from './journal-table-scope'
import type Database from '../../sqlite/sync-database'
import type { JournalEncodedOutcome } from './journal-persistence-plan'
import type { JournalOutcomeSource } from './journal-outcome-format'
import {
  journalOutcomeSource,
  startJournalOutcomeLog,
  advanceJournalOutcomeSource
} from './journal-outcome-format'
import { writeJournalEncodedOutcomes } from './journal-outcome-persistence'
import { AgentSessionJournalError } from './journal-write-guards'

export type JournalOutcomeAppend = {
  sessionId: string
  epoch: string
  previous: JournalOutcomeSource | null
  expectedSequence: number
  through: number
  savedAt: number
  values: readonly JournalEncodedOutcome[]
}

/** Only encoded changed records cross threads; no transcript snapshot or callback is transferred. */
export function applyJournalOutcomeAppend(
  db: Database.Database,
  append: JournalOutcomeAppend,
  tableScope: JournalTableScope = 'main'
): void {
  const actual = journalOutcomeSource(db, append.sessionId, append.epoch, tableScope)
  const expected = append.previous
  if (
    (actual === null) !== (expected === null) ||
    (actual &&
      expected &&
      (actual.generation !== expected.generation ||
        actual.through !== expected.through ||
        actual.prefix !== expected.prefix ||
        actual.format !== expected.format)) ||
    (actual && actual.through !== append.expectedSequence)
  ) {
    throw new AgentSessionJournalError('journal_row_rejected', 'the journal outcome source changed')
  }
  const source =
    actual ??
    startJournalOutcomeLog(
      db,
      append.sessionId,
      append.epoch,
      append.expectedSequence,
      append.savedAt,
      tableScope
    )
  writeJournalEncodedOutcomes(db, source, append.values, tableScope)
  advanceJournalOutcomeSource(db, append.sessionId, append.epoch, append.through, tableScope)
}
