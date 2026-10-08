import { agentJournalItemKey } from '../../../shared/agent-session-journal-item-key'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import { partitionJournalLifecycleMutations } from './journal-lifecycle-batch-partition'
import {
  journalLifecycleBatchRowBuilder,
  type JournalLifecycleMutationInput
} from './journal-row-builders'
import type {
  JournalLifecycleBatchInput,
  JournalResolvedLifecycleBatchInput
} from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'
import { journalBatchRejectionRowBuilders } from './journal-pending-submission-recovery'
import { withoutRestatedStartFailureRows } from './journal-start-failure-run'

const SETTLEMENT_ALREADY_APPLIED = new Error('journal_settlement_already_applied')
const NOTHING_LEFT_TO_WRITE = new Error('journal_lifecycle_batch_nothing_left')

export class JournalLifecycleBatchAppender {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      cursor: () => AgentJournalCursor
      enqueue: (build: (seq: number, ts: number) => JournalRow) => Promise<JournalRow>
      enqueueRows: (
        plan: () => readonly ((seq: number, ts: number) => JournalRow)[]
      ) => Promise<JournalRow[]>
    }
  ) {}

  append(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    const { rejects } = input
    if (rejects) {
      // Planned on the lane: the send if it is still `which` then, and this batch unless it already
      // landed or nothing is left once its run's row is counted. With the send settled meanwhile it
      // failed no one, so nothing is written.
      return this.deps
        .enqueueRows(() => {
          const rejections = journalBatchRejectionRowBuilders(this.deps.state, input.fence, rejects)
          const mutations = withoutRestatedStartFailureRows(this.deps.state(), input.mutations)
          return rejections.length === 0 ||
            mutations.length === 0 ||
            this.wasApplied(input.settlementId)
            ? rejections
            : [
                ...rejections,
                journalLifecycleBatchRowBuilder(
                  this.deps.state,
                  input.settlementId,
                  mutations,
                  input
                )
              ]
        })
        .then(() => this.deps.cursor())
    }
    if (this.wasApplied(input.settlementId)) {
      return Promise.resolve(this.deps.cursor())
    }
    return this.deps
      .enqueue((seq, ts) => {
        if (this.wasApplied(input.settlementId)) {
          throw SETTLEMENT_ALREADY_APPLIED
        }
        const mutations = withoutRestatedStartFailureRows(this.deps.state(), input.mutations)
        // Its only row restated its run's: nothing to write. An empty batch still fails its bound.
        if (mutations.length === 0 && input.mutations.length > 0) {
          throw NOTHING_LEFT_TO_WRITE
        }
        return journalLifecycleBatchRowBuilder(
          this.deps.state,
          input.settlementId,
          mutations,
          input
        )(seq, ts)
      })
      .then((row) => ({ epoch: row.epoch, sequence: row.seq }))
      .catch((error: unknown) => {
        if (error === SETTLEMENT_ALREADY_APPLIED || error === NOTHING_LEFT_TO_WRITE) {
          return this.deps.cursor()
        }
        throw error
      })
  }

  /** The rows a resolved settlement writes, planned at its own turn in the queue: its mutations,
   *  chosen then, in as many consecutive rows as they need, minus any already applied. */
  planResolved(
    input: JournalResolvedLifecycleBatchInput
  ): ((seq: number, ts: number) => JournalRow)[] {
    const mutations = input.resolve()
    // Every chunk is built before any commits, so a second chunk naming the same item would
    // reuse the first chunk's revision.
    this.assertDistinctItems(mutations)
    return partitionJournalLifecycleMutations(input.settlementId, mutations)
      .filter((chunk) => !this.wasApplied(chunk.settlementId))
      .map((chunk) =>
        journalLifecycleBatchRowBuilder(this.deps.state, chunk.settlementId, chunk.mutations, input)
      )
  }

  private assertDistinctItems(mutations: readonly JournalLifecycleMutationInput[]): void {
    const { aliases } = this.deps.state()
    const seen = new Set<string>()
    for (const mutation of mutations) {
      const itemId = agentJournalItemKey(mutation.identity)
      const resolved = aliases.get(itemId) ?? itemId
      if (seen.has(resolved)) {
        throw new Error('journal_resolved_lifecycle_batch_names_item_twice')
      }
      seen.add(resolved)
    }
  }

  private wasApplied(settlementId: string): boolean {
    return this.deps.state().appliedSettlementIds.has(settlementId)
  }
}
