import type { JournalRequestFailureRead } from './journal-request-failure'
import type { AgentSessionConversationOutline } from '../../../shared/agent-session/agent-session-conversation-outline'
import { readJournalDomainOutline } from './journal-domain-outline'
import {
  readJournalDomainForkBoundary,
  readJournalDomainSavedContent,
  type JournalForkBoundary,
  type JournalSavedContent
} from './journal-domain-fork-reads'
import {
  readJournalSqlRequestFailure,
  type JournalRequestFailureResult
} from './journal-sql-request-failure-read'
import {
  readJournalDomainConsumer,
  type JournalConsumerRead,
  type JournalConsumerReadResult
} from './journal-domain-consumer-reads'
import {
  readJournalDomainRewindTarget,
  type JournalRewindTarget
} from './journal-domain-rewind-target'
import {
  readJournalGeneration,
  type JournalGenerationRead,
  type JournalGenerationResult
} from './journal-generation-read'
import { readJournalDomainAcceptedSendUnopened } from './journal-domain-accepted-unopened'
import { readJournalDomainSourceItems } from './journal-domain-source-items'
import {
  readJournalDomainPublication,
  type JournalPublicationRead,
  type JournalPublicationReadResult
} from './journal-domain-publication-read'
import { readJournalDomainEntity } from './journal-domain-entity-read'
import { readJournalDomainLifecycle } from './journal-sql-lifecycle-reads'
import type Database from '../../sqlite/sync-database'
import type { JournalObserverRead, JournalObserverResult } from './journal-observer-read'
import { readJournalSqlObserver } from './journal-sql-observer-read'
import { readJournalSqlWork } from './journal-sql-work-read'
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
import { readJournalSqlProjection } from './journal-sql-read-transaction'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalInputRead, JournalInputReadResult } from './journal-input-reads'
import { readJournalSqlInput } from './journal-sql-input-reads'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlUsageLimitCut, readJournalSqlOrcaStopCut } from './journal-sql-status-cuts'
import type { NativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import type { JournalStatusState } from './journal-status-state'
import { readJournalSqlStatusState } from './journal-sql-status-state'
import type { NativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import type {
  JournalStatusIndicatorRead,
  JournalStatusIndicators
} from './journal-status-indicators'
import { readJournalSqlStatusIndicators } from './journal-sql-status-indicators'
import type { JournalLatestStop } from './context-epochs/journal-stop-turn-end'
import {
  readJournalSqlQueue,
  type JournalSqlQueueRead,
  type JournalSqlQueueReadResult
} from './journal-sql-queued-messages'
import {
  readJournalDomainItems,
  type JournalSqlItemRead,
  type JournalSqlItemReadResult
} from './journal-sql-item-reads'

export type JournalSqlPointRead = {
  sessionId: string
  operation:
    | {
        kind: 'fork-boundary'
        itemId: string
        inheritedAnchor?: string
        compareSubmissions: boolean
      }
    | { kind: 'saved-content' }
    | { kind: 'conversation-outline'; budgetBytes: number }
    | { kind: 'rewind-target'; itemId: string }
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
  | { kind: 'fork-boundary'; boundary: JournalForkBoundary }
  | { kind: 'saved-content'; content: JournalSavedContent }
  | { kind: 'conversation-outline'; outline: AgentSessionConversationOutline }
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
  | { kind: 'usage-limit-cut'; cut: NativeChatUsageLimitCut | null }
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

/** Point procedures decode only the named entity and its captured incarnations. */
export function readJournalSqlPoint(
  db: Database.Database,
  request: JournalSqlPointRead
): JournalSqlPointReadResult {
  return readJournalSqlProjection(db, request.sessionId, (scope) => read(scope, request.operation))
}

function read(
  scope: JournalSqlScope,
  operation: JournalSqlPointRead['operation']
): JournalSqlPointReadResult {
  switch (operation.kind) {
    case 'fork-boundary':
      return {
        kind: operation.kind,
        boundary: readJournalDomainForkBoundary(
          scope,
          operation.itemId,
          operation.inheritedAnchor,
          operation.compareSubmissions
        )
      }
    case 'saved-content':
      return { kind: operation.kind, content: readJournalDomainSavedContent(scope) }
    case 'conversation-outline':
      return {
        kind: operation.kind,
        outline: readJournalDomainOutline(scope, operation.budgetBytes)
      }
    case 'request-failure':
    case 'running-request':
      return readJournalSqlRequestFailure(scope, operation)
    case 'rewind-target':
      return {
        kind: operation.kind,
        target: readJournalDomainRewindTarget(scope, operation.itemId)
      }
    case 'naming-prompt':
    case 'automation-run':
      return readJournalDomainConsumer(scope, operation)
    case 'history-source-items':
      return {
        kind: operation.kind,
        items: readJournalDomainSourceItems(scope, operation.clientMessageIds)
      }
    case 'fork-marker-group':
    case 'projected-stop-notes':
      return readJournalDomainPublication(scope, operation)
    case 'generation':
      return { kind: 'generation', generation: readJournalGeneration(scope, operation.input) }
    case 'work':
      return {
        kind: 'work',
        answer: readJournalSqlWork(new JournalSqlStatusContext(scope), operation.input)
      }
    case 'observer':
      return {
        kind: 'observer',
        observation: readJournalSqlObserver(new JournalSqlStatusContext(scope), operation.input)
      }
    case 'status-indicators': {
      const state = new JournalSqlStatusContext(scope)
      return {
        kind: 'status-indicators',
        indicators: readJournalSqlStatusIndicators(state, operation.input)
      }
    }
    case 'status-state': {
      const state = new JournalSqlStatusContext(scope)
      return {
        kind: 'status-state',
        status: readJournalSqlStatusState(state, operation.currentFence)
      }
    }
    case 'usage-limit-cut':
    case 'orca-stop-cut': {
      const state = new JournalSqlStatusContext(scope)
      return operation.kind === 'usage-limit-cut'
        ? { kind: 'usage-limit-cut', cut: readJournalSqlUsageLimitCut(state) }
        : { kind: 'orca-stop-cut', cut: readJournalSqlOrcaStopCut(state) }
    }
    case 'input-read':
      return { kind: 'input-read', result: readJournalSqlInput(scope, operation.operation) }
    case 'items-by-kind':
    case 'context-floor':
    case 'running-turn':
    case 'context-usage':
    case 'thread-goal-source':
    case 'claude-snapshot':
    case 'named-turn':
    case 'message-options':
    case 'continuation-context':
    case 'history-items':
    case 'claude-history-prompts':
    case 'canonical-item-ids':
      return readJournalDomainItems(
        scope.db,
        { sessionId: scope.sessionId, epoch: scope.epoch },
        operation
      )
    case 'latest-prompt':
    case 'restart-progress':
    case 'outgrown-child':
      return readJournalDomainLifecycle(
        scope.db,
        { sessionId: scope.sessionId, epoch: scope.epoch },
        operation
      )
    case 'metadata':
    case 'provider-turn-in-namespace':
    case 'saved-item-ids':
    case 'item':
    case 'submission':
    case 'submission-body':
    case 'acceptance':
    case 'item-provenance':
    case 'has-recorded-item':
    case 'presentation-removed':
    case 'canonical-item-id':
    case 'has-items':
    case 'provider-activity':
    case 'latest-stop':
    case 'turn-removed':
      return readJournalDomainEntity(scope, operation)
    case 'accepted-send-unopened':
      return {
        kind: 'accepted-send-unopened',
        unopened: readJournalDomainAcceptedSendUnopened(scope)
      }
    case 'queue':
      return { kind: 'queue', result: readJournalSqlQueue(scope, operation.operation) }
  }
}
