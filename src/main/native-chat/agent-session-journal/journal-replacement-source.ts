import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

/** Both replacement owners distinguish genuine removals from view reset/reinsert bookkeeping. */
export function journalReplacementRole<T extends JournalRow>(row: T, materialization: boolean): T {
  return materialization ? { ...row, replayRole: 'materialization-only' } : row
}

export function carriedJournalQuestionInputs(
  previous: JournalReducerState,
  epoch: string,
  fence: number
): JournalRow[] {
  const through = previous.lastSequence
  const source = previous.questionSource
  if (!source) {
    throw new Error('journal_question_source_missing')
  }
  return source.rows.map((row, index) => {
    if (row.seq > through) {
      throw new Error('journal_question_source_ahead')
    }
    return { ...row, epoch, fence, seq: index + 2, replayRole: 'source-only' }
  })
}
