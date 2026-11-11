import type { JournalOutlineCache } from './journal-domain-outline'
import type { JournalMailAttempt, JournalMailObservation } from './journal-mail-observation'
import type { JournalRequestFailureRead } from './journal-request-failure'
import type { JournalRewindCut, JournalRewindSelection } from './journal-domain-rewind-cut'
import type { AgentSessionConversationOutline } from '../../../shared/agent-session/agent-session-conversation-outline'
import type { JournalForkBoundary, JournalSavedContent } from './journal-domain-fork-reads'
import type { JournalRequestFailureResult } from './journal-sql-request-failure-read'
import type {
  JournalConsumerRead,
  JournalConsumerReadResult
} from './journal-domain-consumer-reads'
import type { JournalRewindTarget } from './journal-domain-rewind-target'
import type { JournalGenerationRead, JournalGenerationResult } from './journal-generation-read'
import type {
  JournalPublicationRead,
  JournalPublicationReadResult
} from './journal-domain-publication-read'
import type { JournalObserverRead, JournalObserverResult } from './journal-observer-read'
import type { JournalSqlWorkRead, JournalSqlWorkResult } from './journal-work-read'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalReducerState } from './projection/journal-reducer'
import type { JournalItemEcho } from './projection/journal-item-echo'
import type { JournalInputRead, JournalInputReadResult } from './journal-input-reads'
import type { HostUsageLimitCut } from '../agent-session-wire/recovery/structured-agent-session-usage-limit-chain'
import type { JournalStatusState } from './journal-status-state'
import type { NativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type {
  JournalStatusIndicatorRead,
  JournalStatusIndicators
} from './journal-status-indicators'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import type { JournalSqlQueueRead, JournalSqlQueueReadResult } from './journal-sql-queued-messages'
import type { JournalSqlItemRead, JournalSqlItemReadResult } from './journal-sql-item-reads'

export type JournalSqlPointRead = {
  sessionId: string
  operation:
    | { kind: 'mail-observation'; attempt: JournalMailAttempt }
    | {
        kind: 'fork-boundary'
        itemId: string
        inheritedAnchor?: string
        compareSubmissions: boolean
      }
    | { kind: 'saved-content' }
    | { kind: 'conversation-outline'; budgetBytes: number }
    | { kind: 'rewind-target'; itemId: string }
    | { kind: 'rewind-cut'; target: JournalRewindSelection }
    | { kind: 'history-source-items'; clientMessageIds: readonly string[] }
    | { kind: 'provider-turn-in-namespace'; namespace: string }
    | { kind: 'saved-item-ids'; itemIds: readonly string[] }
    | { kind: 'generation'; input: JournalGenerationRead }
    | { kind: 'observer'; input: JournalObserverRead }
    | { kind: 'work'; input: JournalSqlWorkRead }
    | { kind: 'status-indicators'; input: JournalStatusIndicatorRead }
    | { kind: 'status-state'; currentFence?: number | null }
    | { kind: 'usage-limit-cut' }
    | { kind: 'orca-stop-cut' }
    | { kind: 'input-read'; operation: JournalInputRead }
    | { kind: 'metadata' }
    | { kind: 'item'; itemId: string }
    | { kind: 'item-detail'; itemId: string }
    | { kind: 'submission'; clientMessageId: string }
    | { kind: 'submission-body'; clientMessageId: string }
    | { kind: 'acceptance'; clientMessageId: string }
    | { kind: 'item-provenance'; itemId: string }
    | { kind: 'has-recorded-item'; itemId: string }
    | { kind: 'has-items' }
    | { kind: 'presentation-removed'; itemId: string }
    | { kind: 'canonical-item-id'; itemId: string }
    | { kind: 'provider-activity'; fence: number }
    | { kind: 'latest-stop' }
    | { kind: 'accepted-send-unopened' }
    | { kind: 'turn-removed'; turnId: string }
    | { kind: 'queue'; operation: JournalSqlQueueRead }
    | JournalSqlItemRead
    | JournalPublicationRead
    | JournalConsumerRead
    | JournalRequestFailureRead
}

export type JournalSqlPointReadResult =
  | { kind: 'mail-observation'; observation: JournalMailObservation }
  | { kind: 'rewind-cut'; cut: JournalRewindCut | null }
  | { kind: 'fork-boundary'; boundary: JournalForkBoundary }
  | { kind: 'saved-content'; content: JournalSavedContent }
  | {
      kind: 'conversation-outline'
      outline: AgentSessionConversationOutline
      cache?: JournalOutlineCache
    }
  | JournalRequestFailureResult
  | { kind: 'rewind-target'; target: JournalRewindTarget }
  | { kind: 'history-source-items'; items: AgentJournalRenderItem[] }
  | { kind: 'provider-turn-in-namespace'; present: boolean }
  | { kind: 'saved-item-ids'; itemIds: string[] }
  | { kind: 'generation'; generation: JournalGenerationResult }
  | { kind: 'observer'; observation: JournalObserverResult }
  | { kind: 'work'; answer: JournalSqlWorkResult }
  | { kind: 'status-indicators'; indicators: JournalStatusIndicators }
  | { kind: 'status-state'; status: JournalStatusState }
  | { kind: 'usage-limit-cut'; cut: HostUsageLimitCut | null }
  | { kind: 'orca-stop-cut'; cut: NativeChatOrcaStopCut | null }
  | { kind: 'input-read'; result: JournalInputReadResult }
  | {
      kind: 'metadata'
      cursor: AgentJournalCursor
      physicalCursor: AgentJournalCursor
      oldestSequence: number
      highestFence: number
      queueRevision: string
      lastActivityAt: number
      historyOrigin: JournalReducerState['historyOrigin']
    }
  | { kind: 'item'; item: AgentJournalRenderItem | null }
  | { kind: 'item-detail'; item: AgentJournalRenderItem | null }
  | { kind: 'submission'; submission: AgentJournalSubmission | undefined }
  | { kind: 'submission-body'; body: AgentJournalMessageItem | null }
  | { kind: 'acceptance'; receipt: AgentJournalAcceptanceReceipt | null }
  | {
      kind: 'item-provenance'
      provenance: JournalItemEcho & { ownerFence?: number; executionOwner?: number }
    }
  | { kind: 'has-recorded-item'; recorded: boolean }
  | { kind: 'has-items'; hasItems: boolean }
  | { kind: 'presentation-removed'; removed: boolean }
  | { kind: 'canonical-item-id'; itemId: string }
  | { kind: 'provider-activity'; at: number | undefined }
  | { kind: 'latest-stop'; stop: JournalLatestStop | null }
  | { kind: 'accepted-send-unopened'; unopened: boolean }
  | { kind: 'turn-removed'; removed: boolean }
  | { kind: 'queue'; result: JournalSqlQueueReadResult }
  | JournalSqlItemReadResult
  | JournalPublicationReadResult
  | JournalConsumerReadResult
