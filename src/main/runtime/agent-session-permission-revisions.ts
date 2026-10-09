import { storedAgentChatPermissionMode } from '../../shared/agent-chat-permission-mode'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionStoreState } from './agent-session-store-state'

export function agentSessionPermissionRevision(record: AgentSessionRecord | undefined): number {
  return record?.permissionRevision ?? 0
}

export function reviseAgentSessionPermission(
  before: AgentSessionRecord | undefined,
  record: AgentSessionRecord
): AgentSessionRecord {
  const changed =
    before !== undefined &&
    storedAgentChatPermissionMode(record.provider, record.options) !==
      storedAgentChatPermissionMode(before.provider, before.options)
  const revision = before ? agentSessionPermissionRevision(before) + Number(changed) : 0
  if (!Number.isSafeInteger(revision)) {
    throw new Error('agent_session_permission_revision_exhausted')
  }
  if (record.permissionRevision === revision) {
    return record
  }
  return { ...record, permissionRevision: revision }
}

/** Stamped before serialization, so an intent and its order either both commit or neither does. */
export function stampAgentSessionPermissionRevisions(
  published: AgentSessionStoreState,
  draft: AgentSessionStoreState
): void {
  for (const [id, record] of draft.records) {
    const before = published.records.get(id)
    if (before !== record) {
      draft.records.set(id, reviseAgentSessionPermission(before, record))
    }
  }
}
