// Steps share one queue turn but commit separately; failure preserves earlier steps and skips later ones.

import type {
  JournalItemAppendOptions,
  JournalResolvedLifecycleBatchInput
} from '../journal-store-contracts'
import type { JournalResolvedItem } from './journal-item-appender'
import type { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalReducerState } from '../projection/journal-reducer'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import type { JournalRowWriter } from './journal-row-writer'
import type { JournalWriteBody } from './journal-write-queue'
import { planJournalWriterStep } from './journal-writer-step-plan'
import type {
  JournalWriterStep,
  JournalStepsResult,
  JournalStepOutcome
} from './journal-writer-step'
import { journalSqlFailure } from '../journal-sql-failure'

export type JournalStep =
  | {
      kind: 'item'
      /** Resolve after earlier steps commit; null writes nothing. */
      resolve: () => JournalResolvedItem | null
      options: JournalItemAppendOptions
    }
  | { kind: 'settlement'; batch: JournalResolvedLifecycleBatchInput }
  | { kind: 'command'; step: JournalWriterStep }

export class JournalStepWriter {
  constructor(
    private readonly deps: {
      serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
      state: () => JournalReducerState
      writeRows: JournalRowWriter['writeRows']
      planSettlement: JournalLifecycleBatchAppender['planResolved']
    }
  ) {}

  append(steps: readonly JournalStep[], beforeRun?: () => boolean): Promise<JournalStepsResult> {
    return this.deps.serialize(() => {
      const result: JournalStepsResult = { outcomes: [] }
      if (beforeRun?.() === false) {
        return { outcomes: steps.map(() => ({ kind: 'dropped' as const })) }
      }
      for (const step of steps) {
        try {
          result.outcomes.push(this.write(step))
        } catch (error) {
          result.failure = journalSqlFailure(error)
          break
        }
      }
      return result
    })
  }

  /** Caller already owns the command's write turn and transaction. */
  write(step: JournalStep): JournalStepOutcome {
    let dropped = false
    let outcome: JournalStepOutcome | undefined
    const rows = this.deps.writeRows(() => {
      const plan = this.plan(step, (resolved) => (outcome = resolved))
      dropped = plan === null
      return plan ?? []
    })
    if (outcome?.kind === 'committed') {
      return { ...outcome, wrote: rows.length > 0 }
    }
    return (
      outcome ?? (dropped ? { kind: 'dropped' } : { kind: 'committed', wrote: rows.length > 0 })
    )
  }

  private plan(
    step: JournalStep,
    onResolved: (outcome: JournalStepOutcome) => void
  ): ((seq: number, ts: number) => JournalRow)[] | null {
    if (step.kind === 'command') {
      return planJournalWriterStep(this.deps.state(), step.step, onResolved)
    }
    if (step.kind === 'settlement') {
      return this.deps.planSettlement(step.batch)
    }
    const resolved = step.resolve()
    return resolved === null
      ? null
      : [journalItemRowBuilder(this.deps.state, resolved.identity, resolved.body, step.options)]
  }
}
