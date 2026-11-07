import type Database from '../../sqlite/sync-database'
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
import { JournalSqlReducer } from './journal-sql-reducer'
import { readJournalUsageLimitCut, readJournalOrcaStopCut } from './journal-status-cuts'
import type { NativeChatUsageLimitCut } from '../../../shared/native-chat/native-chat-usage-limit-cut'
import type { NativeChatOrcaStopCut } from '../../../shared/native-chat/native-chat-orca-stop-cut'
import {
  readJournalSqlItems,
  type JournalSqlItemRead,
  type JournalSqlItemReadResult
} from './journal-sql-item-reads'

export type JournalSqlPointRead = {
  sessionId: string
  operation:
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
    | { kind: 'presentation-removed'; itemId: string }
    | { kind: 'canonical-item-id'; itemId: string }
    | { kind: 'provider-activity'; fence: number }
    | JournalSqlItemRead
}

export type JournalSqlPointReadResult =
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
  | { kind: 'presentation-removed'; removed: boolean }
  | { kind: 'canonical-item-id'; itemId: string }
  | { kind: 'provider-activity'; at: number | undefined }
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
    case 'usage-limit-cut':
    case 'orca-stop-cut': {
      const { state } = new JournalSqlReducer(scope, scope.epoch)
      return operation.kind === 'usage-limit-cut'
        ? { kind: 'usage-limit-cut', cut: readJournalUsageLimitCut(state) }
        : { kind: 'orca-stop-cut', cut: readJournalOrcaStopCut(state) }
    }
    case 'input-read':
      return { kind: 'input-read', result: readJournalSqlInput(scope, operation.operation) }
    case 'items-by-kind':
    case 'context-floor':
    case 'running-turn':
    case 'context-usage':
    case 'thread-goal-source':
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
    case 'provider-activity':
      return {
        kind: 'provider-activity',
        at: values.get<number>('providerActivityAt', operation.fence)
      }
  }
}
