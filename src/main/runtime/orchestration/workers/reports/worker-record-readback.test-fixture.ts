import { vi } from 'vitest'
import type { AgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionConversationView } from '../../../../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import type { AgentSessionRecordStore } from '../../../agent-session/records/agent-session-record-store'

/** Inject a changed immutable readback without adding a private-policy writer to production. */
export function replaceWorkerRecordReadback(
  store: AgentSessionRecordStore,
  sessionId: string,
  revise: (record: AgentSessionRecord) => AgentSessionRecord
): void {
  const record = store.getRecord(sessionId)
  if (!record) {
    throw new Error('Worker record fixture is missing.')
  }
  const next = revise(record)
  vi.spyOn(store, 'getRecord').mockImplementation((id) => (id === sessionId ? next : null))
  vi.spyOn(store, 'getConversation').mockImplementation((id) =>
    id === sessionId ? agentSessionConversationView(next) : null
  )
}
