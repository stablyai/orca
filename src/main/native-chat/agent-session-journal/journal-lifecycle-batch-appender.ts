import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalReducerState } from './journal-reducer'
import { journalDispatchRowBuilder } from './journal-row-builders'
import type {
  JournalLifecycleBatchInput,
  JournalPlannedLifecycleBatchInput,
  JournalResolvedLifecycleBatchInput
} from './journal-store-contracts'
import type { JournalRow } from './journal-row-schema'
import { journalQueuedRejectionRowBuilders } from './journal-pending-submission-recovery'
import { planJournalLifecycleRows } from './journal-lifecycle-plan'

export class JournalLifecycleBatchAppender {
  constructor(
    private readonly deps: {
      state: () => JournalReducerState
      cursor: () => AgentJournalCursor
      enqueueRows: (
        plan: (first: number, ts: number) => readonly ((seq: number, ts: number) => JournalRow)[]
      ) => Promise<JournalRow[]>
    }
  ) {}

  append(input: JournalLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.deps
      .enqueueRows((first, ts) => {
        if (this.wasApplied(input.settlementId)) {
          return []
        }
        const leading = (state: () => JournalReducerState) =>
          input.rejectsQueued
            ? journalQueuedRejectionRowBuilders(state, input.fence, input.rejectsQueued)
            : (input.dispatches ?? []).map((dispatch) => journalDispatchRowBuilder(state, dispatch))
        if (input.rejectsQueued && leading(this.deps.state).length === 0) {
          return []
        }
        if (input.rejectsQueued && input.mutations.length === 0) {
          throw new Error('journal_lifecycle_batch_mutation_bound_exceeded')
        }
        return this.fixed(
          planJournalLifecycleRows(this.deps.state(), input, input.mutations, first, ts, leading)
        )
      })
      .then((rows) => this.cursorAfter(rows))
  }

  appendPlanned(input: JournalPlannedLifecycleBatchInput): Promise<AgentJournalCursor> {
    return this.deps
      .enqueueRows((first, ts) => {
        if (this.wasApplied(input.settlementId)) {
          return []
        }
        const { mutations, dispatches } = input.plan()
        return this.fixed(
          planJournalLifecycleRows(this.deps.state(), input, mutations, first, ts, (state) =>
            dispatches.map((dispatch) => journalDispatchRowBuilder(state, dispatch))
          )
        )
      })
      .then((rows) => this.cursorAfter(rows))
  }

  planResolved(
    input: JournalResolvedLifecycleBatchInput,
    first = this.deps.state().lastSequence + 1,
    ts = Date.now()
  ): ((seq: number, ts: number) => JournalRow)[] {
    return this.wasApplied(input.settlementId)
      ? []
      : this.fixed(
          planJournalLifecycleRows(
            this.deps.state(),
            input,
            input.resolve(),
            first,
            ts,
            () => [],
            true
          )
        )
  }

  private fixed(rows: JournalRow[]): (() => JournalRow)[] {
    return rows.map((row) => () => row)
  }

  private cursorAfter(rows: readonly JournalRow[]): AgentJournalCursor {
    const last = rows.at(-1)
    return last ? { epoch: last.epoch, sequence: last.seq } : this.deps.cursor()
  }

  private wasApplied(settlementId: string): boolean {
    return this.deps.state().appliedSettlementIds.has(settlementId)
  }
}
