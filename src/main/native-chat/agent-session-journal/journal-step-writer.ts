// Steps share one queue turn but commit separately; failure preserves earlier steps and skips later ones.

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
      /** Resolve after earlier steps commit; null writes nothing. */
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
