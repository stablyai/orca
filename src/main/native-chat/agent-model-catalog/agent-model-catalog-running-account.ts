// A chat's listings belong to the account it runs on: its running agent's, else the one its next
// start launches under, else the record's. A chat moves accounts when the selection changes.

import type { AgentSessionAccountHome } from '../../../shared/agent-session-account-home'
import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type AgentModelCatalogRunningAccountDeps = {
  /** The account the chat's running agent launched under, when it reports one. */
  liveAccountHome?: (sessionId: string) => AgentSessionAccountHome | undefined
  /** The account the chat's next start launches under; null when it keeps the record's. */
  launchAccountHome?: (record: AgentSessionRecord) => Promise<AgentSessionAccountHome | null>
}

/** The record as its running agent's account keys it; a listing the agent reports is that account's. */
export function onLiveAccount(
  deps: AgentModelCatalogRunningAccountDeps,
  record: AgentSessionRecord
): AgentSessionRecord {
  const accountHome = deps.liveAccountHome?.(record.sessionId)
  return accountHome ? { ...record, accountHome } : record
}

/** For a read: a chat at rest reads the account its next start launches under. */
export async function onRunningAccount(
  deps: AgentModelCatalogRunningAccountDeps,
  record: AgentSessionRecord
): Promise<AgentSessionRecord> {
  if (deps.liveAccountHome?.(record.sessionId)) {
    return onLiveAccount(deps, record)
  }
  const accountHome = await deps.launchAccountHome?.(record).catch(() => null)
  return accountHome ? { ...record, accountHome } : record
}
