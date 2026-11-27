import { createHash } from 'node:crypto'
import { setImmediate } from 'node:timers/promises'
import type { JournalLifecycleIdentityMutationInput } from '../../agent-session-journal/writing/journal-lifecycle-mutation'
import {
  createHistoryCatchUpBatch,
  HISTORY_CATCH_UP_MAX_BYTES,
  HISTORY_CATCH_UP_MAX_OPERATIONS,
  type ExpectedHistoryItem,
  type HistoryCatchUpPlan
} from './structured-agent-session-history-catch-up'

type Batch = ReturnType<typeof createHistoryCatchUpBatch>
type ItemMutation = Extract<JournalLifecycleIdentityMutationInput, { kind: 'item' }>

/** What one import stages across all its commits: memory stays bounded, however long the run. */
export const HISTORY_CATCH_UP_MAX_IMPORT_ROWS = 16 * HISTORY_CATCH_UP_MAX_OPERATIONS
const HISTORY_CATCH_UP_MAX_IMPORT_BYTES = 4 * HISTORY_CATCH_UP_MAX_BYTES

/** Staged bytes between turns, so staging a long import never holds main for more than a slice. */
const STAGED_BYTES_PER_TURN = 1024 * 1024

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
  // Bytes in the commits already full, and what the import had staged at the last turn.
  let closed = 0
  let turnAt = 0
  const total = (): number => closed + current.bytes
  const stage = (put: (batch: Batch) => void): void => {
    try {
      put(current)
    } catch (error) {
      // A full commit starts the next; one entry too large for an empty commit still fails.
      if (!tooLarge(error) || current.size === seeded) {
        throw error
      }
      closed += current.bytes
      current = open()
      put(current)
    }
    // Past it the import is skipped whole, as one past a single commit's bound was before.
    if (total() > HISTORY_CATCH_UP_MAX_IMPORT_BYTES) {
      throw new Error('too-large')
    }
  }
  return {
    push: (mutation: JournalLifecycleIdentityMutationInput) =>
      stage((batch) => batch.push(mutation)),
    revise: (mutation: ItemMutation, expected: Omit<ExpectedHistoryItem, 'key'>) =>
      stage((batch) => batch.revise(mutation, expected)),
    /** A turn once a slice is staged; call between entries. */
    pause: async (): Promise<void> => {
      if (total() - turnAt >= STAGED_BYTES_PER_TURN) {
        turnAt = total()
        await setImmediate()
      }
    },
    /** `head` names the import (not its rows: each commit's own staged content does), so a retry of
     *  the same rows reuses each settlement. One commit is finished per turn. */
    finish: async (settlementPrefix: string, head: unknown): Promise<HistoryCatchUpPlan[]> => {
      const digest = createHash('sha256').update(JSON.stringify(head)).digest('hex')
      const plans: HistoryCatchUpPlan[] = []
      for (const [index, batch] of batches.entries()) {
        if (index > 0) {
          await setImmediate()
        }
        plans.push(
          batch.finish(`${settlementPrefix}:${index}`, [digest, index, batch.contentDigest()])
        )
      }
      return plans
    }
  }
}
