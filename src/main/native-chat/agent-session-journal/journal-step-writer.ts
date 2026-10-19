// Several writes run as ONE turn in the chat's write queue, one after another.
//
// Each step is planned from the fold with every step before it landed, and commits in its own
// transaction. The steps share one queue body, so no other write lands between them, and the
// first step that throws ends the run: the steps before it stay written and none after it runs.

import type {
  JournalItemAppendOptions,
  JournalResolvedLifecycleBatchInput
} from './journal-store-contracts'
import type { JournalResolvedItem } from './journal-item-appender'
import type { JournalLifecycleBatchAppender } from './journal-lifecycle-batch-appender'
import type { JournalReducerState } from './journal-reducer'
import { journalItemRowBuilder } from './journal-row-builders'
import type { JournalRow } from './journal-row-schema'
import type { JournalRowWriter } from './journal-row-writer'
import type { JournalWriteBody } from './journal-write-queue'

export type JournalStep =
  | {
      kind: 'item'
      /** Read at the step's turn; null writes nothing. */
      resolve: () => JournalResolvedItem | null
      options: JournalItemAppendOptions
    }
  | { kind: 'settlement'; batch: JournalResolvedLifecycleBatchInput }

export class JournalStepWriter {
  constructor(
    private readonly deps: {
      serialize: <T>(run: JournalWriteBody<T>) => Promise<T>
      state: () => JournalReducerState
      writeRows: JournalRowWriter['writeRows']
      planSettlement: JournalLifecycleBatchAppender['planResolved']
    }
  ) {}

  /** Whether each step wrote; rejects with the error of the step that threw. */
  append(steps: readonly JournalStep[]): Promise<boolean[]> {
    return this.deps.serialize(() => {
      const wrote: boolean[] = []
      for (const step of steps) {
        wrote.push(this.deps.writeRows(() => this.plan(step)).length > 0)
      }
      return wrote
    })
  }

  private plan(step: JournalStep): ((seq: number, ts: number) => JournalRow)[] {
    if (step.kind === 'settlement') {
      return this.deps.planSettlement(step.batch)
    }
    const resolved = step.resolve()
    return resolved === null
      ? []
      : [journalItemRowBuilder(this.deps.state, resolved.identity, resolved.body, step.options)]
  }
}
