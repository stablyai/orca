import { isolateJournalTransition } from './journal-reducer-transition'
import { applyJournalLifecycleMutation, type JournalReducerState } from './journal-reducer'
import { journalRowSchemaVersion } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { journalRowBase } from './journal-row-builders'
import {
  journalLifecycleMutationForState,
  type JournalLifecycleMutationInput
} from './journal-lifecycle-mutation'
import {
  MAX_JOURNAL_LIFECYCLE_BATCH_BYTES,
  MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS,
  type JournalLifecycleBatchRow
} from './journal-row-schema'

type RowBuilder<T> = (seq: number, ts: number) => T

export function journalLifecycleBatchRowBuilder(
  state: () => JournalReducerState,
  settlementId: string,
  mutations: readonly JournalLifecycleMutationInput[],
  /** Each mutation owns producer linkage; whole-row stamping would misattribute mixed-agent batches. */
  options: { fence: number; recovered?: true },
  revisions?: Map<string, number>
): RowBuilder<JournalLifecycleBatchRow> {
  return (seq, ts) => {
    if (mutations.length === 0 || mutations.length > MAX_JOURNAL_LIFECYCLE_BATCH_MUTATIONS) {
      throw new Error('journal_lifecycle_batch_mutation_bound_exceeded')
    }
    const current = state()
    const runningRevisions = revisions ?? new Map<string, number>()
    const draft = isolateJournalTransition(current, () => undefined).state
    const row: JournalLifecycleBatchRow = {
      kind: 'lifecycle-batch',
      settlementId,
      mutations: [],
      ...journalRowBase(current.epoch, seq, options.fence, ts),
      ...(options.recovered ? { recovered: options.recovered } : {})
    }
    for (const mutation of mutations) {
      const built = journalLifecycleMutationForState(
        draft,
        mutation,
        options.fence,
        runningRevisions
      )
      if (built) {
        applyJournalLifecycleMutation(draft, row, built, row.mutations.length)
        row.mutations.push(built)
      }
    }
    row.v = journalRowSchemaVersion(
      row.mutations.flatMap((mutation) => (mutation.kind === 'item' ? [mutation.body] : []))
    )
    if (Buffer.byteLength(JSON.stringify(row), 'utf8') + 1 > MAX_JOURNAL_LIFECYCLE_BATCH_BYTES) {
      throw new Error('journal_lifecycle_batch_byte_bound_exceeded')
    }
    return row
  }
}
