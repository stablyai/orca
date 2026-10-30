import { randomUUID } from 'node:crypto'
import type Database from '../../sqlite/sync-database'
import { applyJournalRow, createJournalReducerState, type JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import { insertJournalRow } from './journal-row-table'
import { journalOutcomeSource, publishJournalOutcomeSource } from './journal-outcome-format'
import { persistJournalOutcomeRows } from './journal-outcome-table'
import { journalCacheMatches, writeJournalOutcomeCache } from './journal-outcome-cache'
import { isolateJournalTransition } from './journal-reducer-transition'
import { writeJournalProjectionSavepoint } from './journal-saved-state'

export function prepareJournalOutcomeWrite(
  db: Database.Database, live: JournalReducerState, rows: readonly JournalRow[], savedAt: number, allowCache = true
): { adopt: () => JournalReducerState; cached: boolean } {
  const source = journalOutcomeSource(db, live.sessionId, live.epoch)
  // Inputs remain the authority until an invisible conversion generation is published.
  if (!source) {
    const transition = persistLegacyRows(db, live, rows, savedAt)
    return { adopt: transition, cached: false }
  }
  if (source.through !== live.lastSequence) {
    throw new Error('journal outcome writer has stale coverage')
  }
  const transition = persistJournalOutcomeRows(db, live, source.generation, rows, savedAt)
  db.prepare(`UPDATE journal_outcome_epochs SET through_seq = ?
    WHERE session_id = ? AND epoch = ?`).run(transition.state.lastSequence, live.sessionId, live.epoch)
  let cached = false
  if (allowCache) {
    const recovered = writeJournalProjectionSavepoint(db, live.sessionId, () => {
      if (journalCacheMatches(db, live.sessionId, live.epoch, source)) {
        writeJournalOutcomeCache(db, transition.state, source.generation, transition.values)
        cached = true
      }
    })
    cached &&= recovered
  }
  return { adopt: transition.adopt, cached }
}

function persistLegacyRows(
  db: Database.Database, live: JournalReducerState, rows: readonly JournalRow[], savedAt: number
): () => JournalReducerState {
  for (const row of rows) {
    insertJournalRow(db, live.sessionId, row, savedAt)
  }
  return isolateJournalTransition(live, (draft) => {
    for (const row of rows) {
      applyJournalRow(draft, row, savedAt)
    }
  }).adopt
}

/** Epoch builders use the same transition encoder; only their founding input remains as a fence. */
export function publishJournalOutcomeEpoch(
  db: Database.Database, sessionId: string, epoch: string, rows: readonly JournalRow[]
): { adopt: () => JournalReducerState; through: number } {
  const generation = randomUUID()
  const initial = createJournalReducerState(sessionId, epoch)
  const transition = persistJournalOutcomeRows(db, initial, generation, rows)
  const first = rows[0]
  if (!first || first.seq !== 1 || first.kind !== 'epoch') {
    throw new Error('missing founding epoch')
  }
  insertJournalRow(db, sessionId, first)
  publishJournalOutcomeSource(db, sessionId, epoch, generation, transition.state.lastSequence)
  const cached = writeJournalProjectionSavepoint(db, sessionId, () =>
    writeJournalOutcomeCache(db, transition.state, generation, transition.values))
  return { adopt: transition.adopt, through: cached ? transition.state.lastSequence : 0 }
}
