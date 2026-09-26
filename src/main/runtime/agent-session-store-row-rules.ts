/**
 * What makes one row of the agent-session store file readable. A load applies these to every row it
 * parses; a transaction applies them to every row it changed before saving, so the bytes this build
 * writes are exactly the bytes a later load accepts, and a load only has to check bytes another
 * writer produced.
 */

import {
  agentSessionOperationKey,
  isAgentSessionOperationRow,
  type AgentSessionOperationRow
} from '../../shared/agent-session-operation-ledger'
import { isAgentSessionId, isPersistedAgentSessionRecord } from '../../shared/agent-session-record'
import { isAgentSessionSurfaceTabId } from '../../shared/agent-session-surface-tab-id'
import type { RetiredAgentSessionClaimKey } from './agent-session-record-store-file'
import type { PersistedAgentSessionTab } from './agent-session-tab-table'

/** A record row a load keeps in `records` rather than quarantining. */
export function isReadableAgentSessionStoreRecord(sessionId: string, value: unknown): boolean {
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

export function isReadableAgentSessionStoreUnusableRecord(
  value: unknown
): value is { reason: string; raw: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'reason' in value &&
    typeof value.reason === 'string' &&
    value.reason.length > 0
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

/** One chat tab entry; a table is readable when every entry is and no id repeats. */
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
