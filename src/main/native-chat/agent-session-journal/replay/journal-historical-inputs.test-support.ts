import type Database from '../../../sqlite/sync-database'
import type { AgentSessionJournal } from '../journal-store'
import { journalOutcomeSource } from '../outcomes/journal-outcome-format'
import { readJournalSessionEpoch, insertJournalRow } from '../durable-rows/journal-row-table'
import { applyJournalRow } from '../projection/journal-reducer'
import { isolateJournalTransition } from '../projection/journal-reducer-transition'

/** Input fixtures stand for a chat an older build wrote and goes on writing: writes to its input
 * epoch stay input rows, as that build's writer stored them, so the input reader meets writer-made
 * rows. A context this build replaces uses its current writer, including logical replacement. */
const historicalWriters = new WeakMap<AgentSessionJournal, (() => void) | null>()

/** End historical authoring; subsequent operations use the unmodified production writer. */
export function finishTestJournalHistoricalInputs(journal: AgentSessionJournal): void {
  historicalWriters.get(journal)?.()
}

export function pinTestJournalInputMode(journal: AgentSessionJournal): void {
  const projection = journal['projection']
  const prepare = projection.prepare.bind(projection)
  const db = journal['database'].db
  const sessionId = journal['identity'].sessionId
  const epoch = readJournalSessionEpoch(db, sessionId)
  if (historicalWriters.has(journal) || (epoch && journalOutcomeSource(db, sessionId, epoch))) {
    return
  }
  historicalWriters.set(journal, () => {
    projection.prepare = prepare
    historicalWriters.set(journal, null)
  })
  projection.prepare = (db, rows, savedAt, finishFold) => {
    const state = journal['state']
    if (
      journalOutcomeSource(db, state.sessionId, state.epoch) ||
      rows.some((row) => row.kind === 'epoch')
    ) {
      const adopt = prepare(db, rows, savedAt, finishFold)
      return () => {
        adopt()
        finishTestJournalHistoricalInputs(journal)
      }
    }
    const transition = isolateJournalTransition(state, (draft) => {
      for (const row of rows) {
        applyJournalRow(draft, row, savedAt)
      }
      finishFold?.(draft)
    })
    for (const row of rows) {
      insertJournalRow(db, state.sessionId, row, savedAt)
    }
    return () => {
      transition.adopt()
    }
  }
}

export function assertTestJournalHistoricalInputs(
  db: Database.Database,
  journal: AgentSessionJournal
): void {
  const state = journal['state']
  if (!historicalWriters.get(journal) || journalOutcomeSource(db, state.sessionId, state.epoch)) {
    throw new Error('historical journal authoring ended at current-writer takeover')
  }
}
