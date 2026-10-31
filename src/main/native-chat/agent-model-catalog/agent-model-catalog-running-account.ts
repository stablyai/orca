// A chat's listings belong to the account it runs on: its running agent's, else the one its next
// start launches under, else the record's. A chat moves accounts when the selection changes.

import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentSessionConversationView } from '../../../shared/agent-session-conversation-view'
import type { AgentModelCatalogRecord } from './agent-model-catalog-workspace'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type AgentModelCatalogRunningAccountDeps = {
  /** The account the chat's running agent launched under, when it reports one. */
  liveAccountHome?: (sessionId: string) => AgentSessionAccountHome | undefined
  /** The next launch's account; null keeps the record's, rejection means it cannot be read now. */
  launchAccountHome?: (record: AgentSessionRecord) => Promise<AgentSessionAccountHome | null>
}

/** The record as its running agent's account keys it; a listing the agent reports is that account's. */
export function onLiveAccount<T extends AgentModelCatalogRecord>(
  deps: AgentModelCatalogRunningAccountDeps,
  record: T
): T {
  const accountHome = deps.liveAccountHome?.(record.sessionId)
  return accountHome ? { ...record, accountHome } : record
}

/** For a read: a chat at rest reads the account its next start launches under. */
export async function onRunningAccount(
  deps: AgentModelCatalogRunningAccountDeps & {
    getRecord: (sessionId: string) => AgentSessionRecord | undefined
  },
  record: AgentSessionConversationView
): Promise<AgentSessionConversationView> {
  if (deps.liveAccountHome?.(record.sessionId)) {
    return onLiveAccount(deps, record)
  }
  const writable = deps.getRecord(record.sessionId)
  const accountHome = writable ? await deps.launchAccountHome?.(writable) : undefined
  return accountHome ? { ...record, accountHome } : record
}

export type AgentModelCatalogReadRecords = {
  record: AgentSessionConversationView | undefined
  scoped: AgentSessionConversationView | undefined
  savedOnly: boolean
}

/** A failed account read is distinct from a recordless new-chat read. */
export async function resolveAgentModelCatalogReadRecords(
  deps: AgentModelCatalogRunningAccountDeps & {
    getConversation: (id: string) => AgentSessionConversationView | undefined
    getRecord: (id: string) => AgentSessionRecord | undefined
    drivesRecord: (record: AgentModelCatalogRecord) => boolean
  },
  params: { agent: string; sessionId?: string; savedOnly?: boolean }
): Promise<AgentModelCatalogReadRecords | null> {
  const record = params.sessionId ? deps.getConversation(params.sessionId) : undefined
  const savedOnly = params.savedOnly || !!(record && !deps.getRecord(record.sessionId))
  let scoped: typeof record
  if (record && (record.provider !== params.agent || !deps.drivesRecord(record))) {
    return null
  }
  if (record) {
    try {
      scoped = await onRunningAccount(deps, record)
    } catch {
      return null
    }
  }
  return { record, scoped, savedOnly }
}
