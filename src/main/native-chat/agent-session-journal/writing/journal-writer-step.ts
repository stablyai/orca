import type { AgentJournalOrcaCardItem } from '../../../../shared/agent-journal-orca-card-items'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalPlainStatusItem,
  AgentJournalRenderItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  JournalItemAppendInput,
  JournalItemAppendOptions,
  JournalLifecycleBatchInput
} from '../journal-store-contracts'
import type { JournalSqlFailure } from '../journal-sql-failure'
import type { JournalLifecycleIdentityMutationInput } from './journal-lifecycle-mutation'
import type { JournalTimelineItemResolution } from './journal-timeline-resolution'
import type { ProviderTimelineSettlementResolution } from '../../agent-session-timeline/provider-timeline-writer-resolution'
import type { NativeCopyOrigin } from '../context-epochs/journal-history-origin'

export type JournalHistoryResolution = {
  kind: 'history-catch-up'
  expectedCursor: AgentJournalCursor
  expectedItems: readonly { key: string; canonicalItemId: string; revision: number }[]
  mutations: readonly JournalLifecycleIdentityMutationInput[]
  historyOrigin?: NativeCopyOrigin
  permit: Int32Array<SharedArrayBuffer>
  deadline: number
}

export type JournalWriterSettlementResolution =
  | JournalHistoryResolution
  | ProviderTimelineSettlementResolution

export type JournalWriterStep =
  | ({ kind: 'item'; reservedBytes: number } & JournalItemAppendInput)
  | {
      kind: 'lifecycle'
      reservedBytes: number
      input: Pick<JournalLifecycleBatchInput, 'settlementId' | 'mutations' | 'fence' | 'ownerFence'>
    }
  | (Omit<JournalItemAppendInput, 'body'> & {
      kind: 'creation-fact'
      epoch: string
      reservedBytes: number
      /** Orca's own cards and status lines; each named once by its identity. */
      body: AgentJournalOrcaCardItem | AgentJournalPlainStatusItem
    })
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
      resolution: JournalWriterSettlementResolution
    }

export type JournalStepOutcome =
  | {
      kind: 'committed'
      wrote: boolean
      stopped?: true
    }
  | {
      kind: 'dropped'
      reason?: 'turn-settled' | 'item-settled'
      turnItemId?: string
      stopped?: true
    }

export type JournalStepsResult = {
  outcomes: JournalStepOutcome[]
  cursor?: AgentJournalCursor
  items?: AgentJournalRenderItem[]
  failure?: JournalSqlFailure
}
