import { admitLegacyAgentStatus } from '../../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status-legacy-adapter'
import {
  agentContextUsageEqual,
  normalizeAgentContextUsage,
  type AgentContextUsage
} from '../../../shared/agent-context-pressure'
import { isValidPaneKey } from './server-status-identity'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerStatusApplication } from './server-status-application'

export abstract class AgentHookServerContextUsage extends AgentHookServerStatusApplication {
  /** Upsert a provider-reported context reading onto a pane's cached status row.
   *  Provider-neutral seam: fed by the Claude statusline today, other providers later.
   *  No row is fabricated — a reading with no established status entry is dropped
   *  (the feed re-reports within its throttle window once hooks create the row). */
  applyPaneContextUsage(
    rawPaneKey: string,
    usage: AgentContextUsage | null,
    providerSessionId?: string
  ): void {
    if (!this.contextPressureEnabled) {
      return
    }
    const paneKey = this.resolvePaneKeyAlias(
      typeof rawPaneKey === 'string' ? rawPaneKey.trim() : ''
    )
    if (!isValidPaneKey(paneKey) || this.getAgentStatusDisposition(paneKey, {}) === 'suppress') {
      return
    }
    const existing = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (!existing || existing.providerSessionOnly) {
      return
    }
    // Why: a session-tagged reading needs an ESTABLISHED row identity — before the row's
    // first identity-bearing hook lands, a tagged reading can only be a stale post from a
    // prior session (or aimed at a provider that never reports ids). Drop it; the feed
    // re-reports within its throttle window once identity is stamped.
    if (providerSessionId !== undefined && providerSessionId !== existing.providerSession?.id) {
      return
    }
    const normalized = normalizeAgentContextUsage(usage)
    if (
      normalized === undefined ||
      agentContextUsageEqual(existing.payload.contextUsage, normalized)
    ) {
      return
    }
    const updated: EnrichedAgentHookEventPayload = {
      ...existing,
      payload: { ...existing.payload, contextUsage: normalized }
    }
    admitLegacyAgentStatus(
      this.state,
      'main-context-usage-update',
      updated,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
    this.scheduleStatusPersist()
    // Why: skip notifyStatusChangeListeners — those notifications carry only state/receivedAt, neither changed.
    this.emitEnrichedStatus(updated)
  }
}
