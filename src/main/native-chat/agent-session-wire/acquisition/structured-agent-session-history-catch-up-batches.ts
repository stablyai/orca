import type { JournalLifecycleIdentityMutationInput } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import {
  createHistoryCatchUpBatch,
  type ExpectedHistoryItem,
  type HistoryCatchUpPlan
} from './structured-agent-session-history-catch-up'

type Batch = ReturnType<typeof createHistoryCatchUpBatch>
type ItemMutation = Extract<JournalLifecycleIdentityMutationInput, { kind: 'item' }>

const tooLarge = (error: unknown): boolean =>
  error instanceof Error && error.message === 'too-large'

/**
 * An import past one commit's bound, split into commits that each stay inside it and land in
 * order. `seed` stages what every commit needs first (the items the import's rows depend on).
 */
export function createHistoryCatchUpBatches(seed: (batch: Batch) => void) {
  const batches: Batch[] = []
  let seeded = 0
  const open = (): Batch => {
    const batch = createHistoryCatchUpBatch()
    seed(batch)
    seeded = batch.size
    batches.push(batch)
    return batch
  }
  let current = open()
  const stage = (put: (batch: Batch) => void): void => {
    try {
      put(current)
    } catch (error) {
      // A full commit starts the next; one entry too large for an empty commit still fails.
      if (!tooLarge(error) || current.size === seeded) {
        throw error
      }
      current = open()
      put(current)
    }
  }
  return {
    push: (mutation: JournalLifecycleIdentityMutationInput) =>
      stage((batch) => batch.push(mutation)),
    revise: (mutation: ItemMutation, expected: Omit<ExpectedHistoryItem, 'key'>) =>
      stage((batch) => batch.revise(mutation, expected)),
    finish: (settlementPrefix: string, digestOf: unknown): HistoryCatchUpPlan[] =>
      batches.map((batch, index) => batch.finish(`${settlementPrefix}:${index}`, [digestOf, index]))
  }
}
