import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import { journalLifecycleBatchRowBuilder } from './journal-row-builders'
import type { JournalLifecycleBatchInput } from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'
import { journalQueuedRejectionRowBuilders } from './journal-pending-submission-recovery'

const SETTLEMENT_ALREADY_APPLIED = new Error('journal_settlement_already_applied')

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
    const { rejectsQueued } = input
    if (rejectsQueued) {
      // Planned on the lane: the sends queued then, and this batch unless it already landed. With
      // none left (a Stop withdrew them first) it failed no one, so nothing is written.
      return this.deps
        .enqueueRows(() => {
          const rejections = journalQueuedRejectionRowBuilders(
            this.deps.state,
            input.fence,
            rejectsQueued
          )
          return rejections.length === 0 || this.wasApplied(input.settlementId)
            ? rejections
            : [
                ...rejections,
                journalLifecycleBatchRowBuilder(
                  this.deps.state,
                  input.settlementId,
                  input.mutations,
                  input
                )
              ]
        })
        .then(() => this.deps.cursor())
    }
    if (this.wasApplied(input.settlementId)) {
      return Promise.resolve(this.deps.cursor())
    }
    const build = journalLifecycleBatchRowBuilder(
      this.deps.state,
      input.settlementId,
      input.mutations,
      input
    )
    return this.deps
      .enqueue((seq, ts) => {
        if (this.wasApplied(input.settlementId)) {
          throw SETTLEMENT_ALREADY_APPLIED
        }
        return build(seq, ts)
      })
      .then((row) => ({ epoch: row.epoch, sequence: row.seq }))
      .catch((error: unknown) => {
        if (error === SETTLEMENT_ALREADY_APPLIED) {
          return this.deps.cursor()
        }
        throw error
      })
  }

  private wasApplied(settlementId: string): boolean {
    return this.deps.state().appliedSettlementIds.has(settlementId)
  }
}
