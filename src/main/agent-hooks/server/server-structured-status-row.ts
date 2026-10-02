import {
  pickParsedAgentStatusPayload,
  type AgentStatusIpcPayload
} from '../../../shared/agent-status-types'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** Canonical rows supply legacy fanout without retaining a writable pane copy. */
export function structuredStatusLegacyEvent(
  row: AgentStatusIpcPayload
): EnrichedAgentHookEventPayload {
  return {
    paneKey: row.paneKey,
    tabId: row.tabId,
    worktreeId: row.worktreeId,
    connectionId: row.connectionId,
    receivedAt: row.receivedAt,
    stateStartedAt: row.stateStartedAt,
    evidenceObservedAt: row.evidenceObservedAt,
    structuredHost: row.structuredHost,
    ...(row.providerSession ? { providerSession: row.providerSession } : {}),
    ...(row.observation ? { observation: row.observation } : {}),
    payload: pickParsedAgentStatusPayload(row)
  }
}
