import type { JournalPersistencePlan } from './journal-persistence-plan'
import type { JournalReadConnection } from './journal-sql-owner'
import type { AgentSessionJournal } from './journal-store'
import { serializeJournalRow } from './journal-row-schema'
import { applyJournalRow } from './journal-reducer'
import { isolateJournalTransition } from './journal-reducer-transition'

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
  if (historicalWriters.has(journal)) {
    return
  }
  historicalWriters.set(journal, () => {
    projection.prepare = prepare
    historicalWriters.set(journal, null)
  })
  projection.prepare = async (db, rows, savedAt, finishFold) => {
    const state = journal['state']
    if (
      (await db.source(state.sessionId, state.epoch)) ||
      rows.some((row) => row.kind === 'epoch')
    ) {
      const adopt = await prepare(db, rows, savedAt, finishFold)
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
      db.add({
        kind: 'rows',
        sessionId: state.sessionId,
        rows: [{ epoch: row.epoch, seq: row.seq, savedAt, json: serializeJournalRow(row) }]
      })
    }
    return () => {
      transition.adopt()
    }
  }
}

export async function assertTestJournalHistoricalInputs(
  db: Pick<JournalReadConnection, 'source'> | JournalPersistencePlan,
  journal: AgentSessionJournal
): Promise<void> {
  const state = journal['state']
  if (!historicalWriters.get(journal) || (await db.source(state.sessionId, state.epoch))) {
    throw new Error('historical journal authoring ended at current-writer takeover')
  }
}
