import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalItemAppendInput, JournalItemAppendOptions } from '../journal-store-contracts'
import type { JournalSqlFailure } from '../journal-sql-failure'
import type { JournalLifecycleIdentityMutationInput } from './journal-lifecycle-mutation'
import type { JournalTimelineItemResolution } from './journal-timeline-resolution'

export type JournalHistoryResolution = {
  kind: 'history-catch-up'
  expectedCursor: AgentJournalCursor
  expectedItems: readonly { key: string; canonicalItemId: string; revision: number }[]
  mutations: readonly JournalLifecycleIdentityMutationInput[]
  permit: Int32Array<SharedArrayBuffer>
  deadline: number
}

export type JournalWriterStep =
  | ({ kind: 'item'; reservedBytes: number } & JournalItemAppendInput)
  | {
      kind: 'resolved-item'
      reservedBytes: number
      options: JournalItemAppendOptions
      resolution: JournalTimelineItemResolution
    }
  | {
      kind: 'settlement'
      settlementId: string
      reservedBytes: number
      fence: number
      ownerFence?: number
      recovered?: true
      resolution: JournalHistoryResolution
    }

export type JournalStepOutcome =
  | { kind: 'committed'; wrote: boolean }
  | { kind: 'dropped'; reason?: 'turn-settled'; turnItemId?: string }

export type JournalStepsResult = {
  outcomes: JournalStepOutcome[]
  failure?: JournalSqlFailure
}
