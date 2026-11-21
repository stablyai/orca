import {
  agentSessionExecutionLocationsEqual,
  type AgentSessionExecutionLocation,
  type AgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionLeaseIsReleased } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import { setAgentSessionTabVisibility } from './agent-session-tab-table'
import { clearSuccessor } from './agent-session-sender-identity-revision'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { DeletedChat } from '../../../native-chat/chat-deletion/deleted-chats'

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
  state.records.delete(forget.sessionId)
  return true
}

/** A whole chat to delete for good: every session of its /clear lineage, and the agent
 *  conversations it held, which Orca then never lists or adopts again. */
export type AgentSessionChatForget = Readonly<DeletedChat>

/** Deletes every record of the chat and its tabs, or none: each lease must be released, and a /clear
 *  continuation outside the set keeps the chat it came from. A saved open turn doesn't refuse: a
 *  quit mid-turn leaves one for good, and the caller's lanes already prove nothing runs. */
export function forgetAgentSessionChat(
  state: AgentSessionStoreState,
  forget: AgentSessionChatForget,
  legacyTabIds: readonly string[]
): boolean {
  const ids = new Set(forget.sessionIds)
  for (const sessionId of ids) {
    const record = state.records.get(sessionId)
    const successor = clearSuccessor(record)
    if (
      !record ||
      !agentSessionLeaseIsReleased(record.lease) ||
      (successor !== null &&
        !ids.has(successor) &&
        (state.records.has(successor) || state.unreadableRecords.has(successor)))
    ) {
      return false
    }
  }
  for (const sessionId of ids) {
    setAgentSessionTabVisibility(state, sessionId, false, undefined, legacyTabIds)
    state.records.delete(sessionId)
  }
  return true
}
