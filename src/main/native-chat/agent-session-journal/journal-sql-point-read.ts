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
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalReducerState } from './projection/journal-reducer'
import type { JournalItemEcho } from './projection/journal-item-echo'
import type { JournalInputSource } from './input-order/journal-input-source-schema'
import { journalInputSourceBody } from './input-order/journal-input-source'
import { journalContextEpoch } from './context-epochs/journal-context-cursor'
import { JournalSqlReadValues } from './journal-sql-read-values'
import { readJournalSqlProjection } from './journal-sql-read-transaction'
import { JournalSqlScalars } from './journal-sql-scalars'
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
import {
  latestAcceptedSendUnopened,
  type JournalLatestStop
} from './context-epochs/journal-stop-turn-end'
import { JournalSqlReducer } from './journal-sql-reducer'
import {
  detachJournalSqlStop,
  readJournalSqlQueue,
  type JournalSqlQueueRead,
  type JournalSqlQueueReadResult
} from './journal-sql-queued-messages'
import {
  readJournalSqlItems,
  type JournalSqlItemRead,
  type JournalSqlItemReadResult
} from './journal-sql-item-reads'

export type JournalSqlPointRead = {
  sessionId: string
  operation:
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
    | { kind: 'canonical-item-ids'; itemIds: readonly string[] }
    | { kind: 'provider-activity'; fence: number }
    | { kind: 'latest-stop' }
    | { kind: 'accepted-send-unopened' }
    | { kind: 'turn-removed'; turnId: string }
    | { kind: 'queue'; operation: JournalSqlQueueRead }
    | JournalSqlItemRead
}

export type JournalSqlPointReadResult =
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
  | { kind: 'canonical-item-ids'; items: { itemId: string; canonicalItemId: string }[] }
  | { kind: 'provider-activity'; at: number | undefined }
  | { kind: 'latest-stop'; stop: JournalLatestStop | null }
  | { kind: 'accepted-send-unopened'; unopened: boolean }
  | { kind: 'turn-removed'; removed: boolean }
  | { kind: 'queue'; result: JournalSqlQueueReadResult }
  | JournalSqlItemReadResult

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
  const values = new JournalSqlReadValues(scope, () => {})
  const scalars = new JournalSqlScalars(scope, 'reducer')
  const epoch = () => journalContextEpoch(scope.epoch, scalars.get('contextBoundary', 1))
  const canonical = (itemId: string) => values.get<string>('aliases', itemId) ?? itemId
  const visible = (itemId: string) => {
    const identity = parseAgentJournalItemKey(itemId)
    return (
      identity?.provider !== 'orca' ||
      !values.has('inputs.rejections', identity.clientMessageId) ||
      values.has('inputs.presentations', identity.clientMessageId)
    )
  }
  switch (operation.kind) {
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
    case 'named-turn':
      return readJournalSqlItems(
        {
          scope,
          item: (itemId) => values.get<AgentJournalRenderItem>('items', itemId),
          visible,
          epoch
        },
        operation
      )
    case 'metadata': {
      const sequence = scalars.get('lastSequence', 0)
      return {
        kind: 'metadata',
        cursor: { epoch: epoch(), sequence },
        physicalCursor: { epoch: scope.epoch, sequence },
        oldestSequence: scalars.get('oldestSequence', 1),
        highestFence: scalars.get('highestFence', 0),
        lastActivityAt: scalars.get('lastActivityAt', 0),
        historyOrigin: scalars.get<JournalReducerState['historyOrigin']>('historyOrigin', null)
      }
    }
    case 'item':
      return {
        kind: 'item',
        item: visible(operation.itemId)
          ? (values.get<AgentJournalRenderItem>('items', operation.itemId) ?? null)
          : null
      }
    case 'submission':
      return {
        kind: 'submission',
        submission: values.get<AgentJournalSubmission>('submissions', operation.clientMessageId)
      }
    case 'submission-body':
      return {
        kind: 'submission-body',
        body: journalInputSourceBody(
          values.get<JournalInputSource>('inputs.sources', operation.clientMessageId)
        )
      }
    case 'acceptance': {
      const receipt = values.get<AgentJournalAcceptanceReceipt>(
        'receipts',
        operation.clientMessageId
      )
      return {
        kind: 'acceptance',
        receipt: receipt ? { ...receipt, cursor: { ...receipt.cursor, epoch: epoch() } } : null
      }
    }
    case 'item-provenance': {
      const echoOf = values.get<JournalItemEcho['echoOf']>('itemEchoes', operation.itemId)
      return {
        kind: 'item-provenance',
        provenance: {
          ...(values.has('itemEchoes', operation.itemId) ? { echoOf } : {}),
          ownerFence: values.get<number>('itemFences', operation.itemId),
          executionOwner: values.get<number>('itemExecutionOwners', operation.itemId)
        }
      }
    }
    case 'has-recorded-item':
      return {
        kind: 'has-recorded-item',
        recorded:
          values.has('items', operation.itemId) || values.has('tombstones', operation.itemId)
      }
    case 'presentation-removed': {
      const itemId = canonical(operation.itemId)
      return {
        kind: 'presentation-removed',
        removed: values.has('tombstones', itemId) || !visible(itemId)
      }
    }
    case 'canonical-item-id':
      return { kind: 'canonical-item-id', itemId: canonical(operation.itemId) }
    case 'canonical-item-ids':
      return {
        kind: 'canonical-item-ids',
        items: operation.itemIds.map((itemId) => ({ itemId, canonicalItemId: canonical(itemId) }))
      }
    case 'has-items':
      for (const row of scope.db
        .prepare('SELECT entry_key FROM journal_proj_items WHERE session_id=? AND epoch=?')
        .iterate(...scope.prefix)) {
        scope.examined(row)
        if (visible(String(JSON.parse(String(row.entry_key))))) {
          return { kind: 'has-items', hasItems: true }
        }
      }
      return { kind: 'has-items', hasItems: false }
    case 'provider-activity':
      return {
        kind: 'provider-activity',
        at: values.get<number>('providerActivityAt', operation.fence)
      }
    case 'latest-stop': {
      const marks = new JournalSqlScalars(scope, 'pause-marks')
      const { latestStop } = marks.get<{ latestStop: JournalLatestStop | null }>('header', {
        latestStop: null
      })
      return { kind: 'latest-stop', stop: detachJournalSqlStop(latestStop) }
    }
    case 'accepted-send-unopened':
      return {
        kind: 'accepted-send-unopened',
        unopened: latestAcceptedSendUnopened(new JournalSqlReducer(scope, scope.epoch).state)
      }
    case 'turn-removed':
      return {
        kind: 'turn-removed',
        removed: new JournalSqlReducer(scope, scope.epoch).state.removedTurnIds.has(
          operation.turnId
        )
      }
    case 'queue':
      return { kind: 'queue', result: readJournalSqlQueue(scope, operation.operation) }
  }
}
