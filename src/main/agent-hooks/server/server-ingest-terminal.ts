import { track } from '../../telemetry/client'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { terminalStatusPayloadMatchesHook } from '../../../shared/agent-terminal-status-equivalence'
import type { ParsedAgentStatusPayload } from '../../../shared/agent-status-types'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'

export abstract class AgentHookServerIngestTerminal extends AgentHookServerIngestNormalization {
  ingestTerminalStatus(event: {
    paneKey: string
    tabId?: string
    worktreeId?: string
    connectionId?: string | null
    payload: ParsedAgentStatusPayload
  }): void {
    const physicalPaneKey = event.paneKey.trim()
    const paneKey = this.resolvePaneKeyAlias(physicalPaneKey)
    const parsedPaneKey = parsePaneKey(paneKey)
    if (paneKey.length === 0) {
      track('agent_hook_unattributed', { reason: 'empty_pane_key' })
      return
    }
    if (paneKey.length > MAX_PANE_KEY_LEN || !parsedPaneKey) {
      return
    }
    const reportedTabId =
      event.tabId !== undefined && event.tabId.trim().length > 0 ? event.tabId.trim() : undefined
    if (
      paneKey === physicalPaneKey &&
      reportedTabId !== undefined &&
      reportedTabId !== parsedPaneKey.tabId
    ) {
      return
    }
    const tabId = paneKey !== physicalPaneKey ? parsedPaneKey.tabId : reportedTabId
    if (this.getAgentStatusDisposition(paneKey) !== 'accept') {
      return
    }
    const worktreeId =
      event.worktreeId !== undefined && event.worktreeId.trim().length > 0
        ? event.worktreeId.trim()
        : undefined
    const connectionId =
      typeof event.connectionId === 'string' && event.connectionId.trim().length > 0
        ? event.connectionId.trim()
        : null
    const previous = this.state.lastStatusByPaneKey.get(paneKey) as
      | EnrichedAgentHookEventPayload
      | undefined
    if (
      previous?.claudeLeadBoundaryChildOnly === true &&
      previous.payload.agentType === 'claude' &&
      event.payload.agentType === 'claude'
    ) {
      // Why: OSC has no child identity or lead boundary, so it cannot replace a persisted child-only proof before the lifecycle hook arrives.
      return
    }
    // Why: preserve the hook-completed turn stamp while OSC repaints the current state.
    const preserveActiveTurnStamp =
      previous?.payload.turnCompletedAt !== undefined &&
      previous.payload.turnCompletedAt === this.activeHookTurnCompletedAtByPaneKey.get(paneKey)
    if (
      !previous?.restoredUnconfirmed &&
      previous?.connectionId === connectionId &&
      previous.tabId === tabId &&
      previous.worktreeId === worktreeId &&
      terminalStatusPayloadMatchesHook(previous.payload, event.payload, preserveActiveTurnStamp)
    ) {
      return
    }
    // Why: the OSC 9999 wire payload has no providerSession field at all, so an OSC observation is
    // never evidence that the session ended — yet overwriting the row dropped the cached identity.
    // That erased it from persisted rows (lost across restart) and from headless `orca serve`, which
    // serves these rows to mobile directly instead of the renderer store, blanking Chat UI (#10630).
    // A new turn after `done` still starts clean so a reused pane cannot inherit a finished session.
    // Why: mirror resolveAgentStatusIdentity, which treats a literal 'unknown' exactly like an
    // omitted type — an OSC ping that names no agent makes no claim about the pane's identity, so
    // it must not be read as a mismatch and strip the session the renderer would have kept.
    const claimedAgentType =
      event.payload.agentType && event.payload.agentType !== 'unknown'
        ? event.payload.agentType
        : undefined
    const preservedProviderSession =
      previous?.providerSession &&
      (claimedAgentType === undefined || claimedAgentType === previous.payload.agentType) &&
      (previous.payload.state !== 'done' || event.payload.state === 'done')
        ? previous.providerSession
        : undefined
    // Why: OSC status is a runtime observation, not a prompt boundary; keep prompt-sent telemetry tied to native hooks.
    this.applyNormalizedStatus(
      {
        paneKey,
        tabId,
        worktreeId,
        connectionId,
        ...(preservedProviderSession ? { providerSession: preservedProviderSession } : {}),
        payload: event.payload
      },
      undefined,
      'osc'
    )
  }
}
