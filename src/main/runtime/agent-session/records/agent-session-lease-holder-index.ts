import { agentSessionLeaseMayBeHeld } from '../../../../shared/agent-session/lifecycle/leases/agent-session-lease-adjudication'
import type { AgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-store-state'

/** Chats whose lease may be held, kept by committed record writes so lease renewal and restart
 *  reconciliation never walk the history. Derived only; nothing is saved. */
export class AgentSessionLeaseHolderIndex {
  private readonly sessionIds = new Set<string>()

  constructor(state: AgentSessionStoreState) {
    for (const [sessionId, record] of state.records) {
      if (agentSessionLeaseMayBeHeld(record.lease)) {
        this.sessionIds.add(sessionId)
      }
    }
  }

  applyCommitted(
    state: AgentSessionStoreState,
    records: { upsert: readonly (readonly [string, string])[]; remove: readonly string[] }
  ): void {
    for (const [sessionId] of records.upsert) {
      const record = state.records.get(sessionId)
      if (record && agentSessionLeaseMayBeHeld(record.lease)) {
        this.sessionIds.add(sessionId)
      } else {
        this.sessionIds.delete(sessionId)
      }
    }
    for (const sessionId of records.remove) {
      this.sessionIds.delete(sessionId)
    }
  }

  list(state: AgentSessionStoreState): AgentSessionRecord[] {
    return [...this.sessionIds].flatMap((sessionId) => state.records.get(sessionId) ?? [])
  }
}
