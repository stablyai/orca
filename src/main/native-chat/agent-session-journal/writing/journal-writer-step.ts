import type {
  AgentJournalAgentStartItem,
  AgentJournalAgentHandoffItem
} from '../../../../shared/agent-session/journal/agent-journal-creation-facts'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type {
  JournalItemAppendInput,
  JournalItemAppendOptions,
  JournalLifecycleBatchInput
} from '../journal-store-contracts'
import type { JournalSqlFailure } from '../journal-sql-failure'
import type { JournalLifecycleIdentityMutationInput } from './journal-lifecycle-mutation'
import type { JournalTimelineItemResolution } from './journal-timeline-resolution'
import type { ProviderTimelineSettlementResolution } from '../../agent-session-timeline/provider-timeline-writer-resolution'

export type JournalHistoryResolution = {
  kind: 'history-catch-up'
  expectedCursor: AgentJournalCursor
  expectedItems: readonly { key: string; canonicalItemId: string; revision: number }[]
  mutations: readonly JournalLifecycleIdentityMutationInput[]
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
      body: AgentJournalAgentStartItem | AgentJournalAgentHandoffItem
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
