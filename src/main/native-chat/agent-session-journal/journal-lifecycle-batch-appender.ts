import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder, journalLifecycleBatchRowBuilder } from './journal-row-builders'
import type { JournalLifecycleBatchInput, ResolveDispatchInput } from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'

const SETTLEMENT_ALREADY_APPLIED = new Error('journal_settlement_already_applied')

export class JournalLifecycleBatchAppender {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      cursor: () => AgentJournalCursor
      enqueueMany: (
        build: (seq: number, ts: number) => readonly JournalRow[]
      ) => Promise<JournalRow[]>
    }
  ) {}

  append(
    input: JournalLifecycleBatchInput,
    ownerEndedDispatches: () => ResolveDispatchInput[]
  ): Promise<AgentJournalCursor> {
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
      .enqueueMany((seq, ts) => {
        if (this.wasApplied(input.settlementId)) {
          throw SETTLEMENT_ALREADY_APPLIED
        }
        const lifecycle = build(seq, ts)
        const dispatches = ownerEndedDispatches()
        return [
          lifecycle,
          ...dispatches.map((dispatch, index) =>
            journalDispatchRowBuilder(this.deps.state, dispatch)(seq + index + 1, ts)
          )
        ]
      })
      .then((rows) => {
        const row = rows[0]
        if (!row) {
          throw new Error('journal_lifecycle_append_returned_no_rows')
        }
        return { epoch: row.epoch, sequence: row.seq }
      })
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
