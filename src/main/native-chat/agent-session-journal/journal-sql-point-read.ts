import { planJournalDomainRewindCut } from './journal-domain-rewind-cut'
import { readJournalDomainMailObservation } from './journal-domain-mail-observation'
import { readJournalDomainOutline } from './journal-domain-outline'
import {
  readJournalDomainForkBoundary,
  readJournalDomainSavedContent
} from './journal-domain-fork-reads'
import { readJournalSqlRequestFailure } from './journal-sql-request-failure-read'
import { readJournalDomainConsumer } from './journal-domain-consumer-reads'
import { readJournalDomainRewindTarget } from './journal-domain-rewind-target'
import { readJournalGeneration } from './journal-generation-read'
import { readJournalDomainAcceptedSendUnopened } from './journal-domain-accepted-unopened'
import { readJournalDomainSourceItems } from './journal-domain-source-items'
import { readJournalDomainPublication } from './journal-domain-publication-read'
import { readJournalDomainEntity } from './journal-domain-entity-read'
import { readJournalDomainLifecycle } from './journal-sql-lifecycle-reads'
import type Database from '../../sqlite/sync-database'
import { readJournalSqlObserver } from './journal-sql-observer-read'
import { readJournalSqlWork } from './journal-sql-work-read'
import { readJournalSqlProjection } from './journal-sql-read-transaction'
import type { JournalSqlScope } from './journal-sql-scope'
import { readJournalSqlInput } from './journal-sql-input-reads'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlUsageLimitCut, readJournalSqlOrcaStopCut } from './journal-sql-status-cuts'
import { readJournalSqlStatusState } from './journal-sql-status-state'
import { readJournalSqlStatusIndicators } from './journal-sql-status-indicators'
import { readJournalSqlQueue } from './journal-sql-queued-messages'
import { readJournalDomainItems } from './journal-sql-item-reads'

export type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read-types'
import type { JournalSqlPointRead, JournalSqlPointReadResult } from './journal-sql-point-read-types'

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
    case 'mail-observation':
      return {
        kind: operation.kind,
        observation: readJournalDomainMailObservation(scope, operation.attempt)
      }
    case 'rewind-cut':
      return {
        kind: operation.kind,
        cut: planJournalDomainRewindCut(scope, operation.target)?.cut ?? null
      }
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
        ...readJournalDomainOutline(scope, operation.budgetBytes)
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
    case 'item-detail':
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
