import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation,
  type AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionLeaseIsReleased } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import { setAgentSessionTabVisibility } from './agent-session-tab-table'
import { clearSuccessor } from './agent-session-sender-identity-revision'
import type { AgentSessionStoreState } from './agent-session-store-state'

/** A chat to delete for good, if it is still where the caller saw it and nobody used it since `idleBefore`. */
export type AgentSessionIdleForget = {
  sessionId: string
  location: AgentSessionExecutionLocation
  idleBefore: number
}

/**
 * When the user last started or used the chat. Not `updatedAt` or the lease's renewal: every launch's
 * lease reconciliation moves both without anyone touching the chat. The journal adds its activity.
 */
export function agentSessionRecordLastUsedAt(record: AgentSessionRecord): number {
  return Math.max(record.createdAt, record.lastTurn?.at ?? 0)
}

/** Deletes the record and its tab when no owner holds it; false keeps it. The writer checks the journal first. */
export function forgetIdleAgentSessionRecord(
  state: AgentSessionStoreState,
  forget: AgentSessionIdleForget,
  legacyTabIds: readonly string[]
): boolean {
  const record = state.records.get(forget.sessionId)
  // A /clear continuation takes its identity from this chat, so this one goes only after it.
  const successor = clearSuccessor(record)
  if (
    !record ||
    !agentSessionExecutionLocationsEqual(record.location, forget.location) ||
    !agentSessionLeaseIsReleased(record.lease) ||
    record.lastTurn?.state === 'open' ||
    agentSessionRecordLastUsedAt(record) > forget.idleBefore ||
    (successor !== null && (state.records.has(successor) || state.unreadableRecords.has(successor)))
  ) {
    return false
  }
  setAgentSessionTabVisibility(state, forget.sessionId, false, undefined, legacyTabIds)
  // An ended chat's mark goes with its record, so the ended list never outgrows the chats.
  state.sessionTabs?.forget(forget.sessionId)
  state.records.delete(forget.sessionId)
  return true
}
