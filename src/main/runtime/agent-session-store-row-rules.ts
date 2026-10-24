// Loads and transactions share validation so every committed row remains readable.

import {
  agentSessionOperationKey,
  isAgentSessionOperationRow,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import { isAgentSessionId, isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import type { PersistedAgentSessionRecord } from '../../shared/agent-session-legacy-handoff-lease'
import { isAgentSessionSurfaceTabId } from '../../shared/agent-session-surface-tab-id'
import type { RetiredAgentSessionClaimKey } from './agent-session-store-state'
import type { PersistedAgentSessionTab } from './agent-session/agent-session-tab-table'

export function isReadableAgentSessionStoreRecord(
  sessionId: string,
  value: unknown
): value is PersistedAgentSessionRecord {
  return isPersistedAgentSessionRecord(value) && value.sessionId === sessionId
}

export function isReadableAgentSessionStoreOperation(
  key: string,
  value: unknown
): value is AgentSessionOperationRow {
  return (
    isAgentSessionOperationRow(value) &&
    key === agentSessionOperationKey(value.callerKey, value.operationId)
  )
}

export function isReadableRetiredAgentSessionClaimKey(
  entry: unknown
): entry is RetiredAgentSessionClaimKey {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'keyId' in entry &&
    typeof entry.keyId === 'string' &&
    entry.keyId.length > 0 &&
    entry.keyId.length <= 512 &&
    'retiredAt' in entry &&
    typeof entry.retiredAt === 'number' &&
    Number.isSafeInteger(entry.retiredAt) &&
    entry.retiredAt >= 0
  )
}

export function isReadableAgentSessionStoreTab(entry: unknown): entry is PersistedAgentSessionTab {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'tabId' in entry &&
    isAgentSessionSurfaceTabId(entry.tabId) &&
    'sessionId' in entry &&
    isAgentSessionId(entry.sessionId)
  )
}
