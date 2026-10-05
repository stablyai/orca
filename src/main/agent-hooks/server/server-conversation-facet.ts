import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { conversationProviderSessionsEqual } from '../../../shared/terminal-conversation-identity'
import type { EnrichedAgentHookEventPayload, StoredAgentConversation } from './server-types'

/** Where a write's provider address came from: the incoming event itself, or copied forward. */
export type AgentConversationAddressEvidence = 'reported' | 'carried'

function usableAgentType(agentType: string | undefined): string | null {
  return agentType && agentType !== 'unknown' ? agentType : null
}

/** A row written before facets existed carries its address only at the top level. */
export function seedConversationFromLegacyRow(
  row: EnrichedAgentHookEventPayload | undefined
): StoredAgentConversation | undefined {
  const agentType = usableAgentType(row?.payload.agentType)
  if (!row?.providerSession || !agentType) {
    return undefined
  }
  return {
    agentType,
    providerSession: row.providerSession,
    ...(row.payload.model ? { model: row.payload.model } : {}),
    ...(row.payload.modelSwitchCommand
      ? { modelSwitchCommand: row.payload.modelSwitchCommand }
      : {}),
    capturedAt: row.receivedAt
  }
}

/**
 * The facet a write leaves on the pane. It makes no ownership decision of its own: it takes an
 * address only when the incoming event reported one and admission kept that address, so the rule
 * that decides the legacy `providerSession` decides the facet too. A repeat of the facet's address
 * and model returns the same object, so relayed transcript polls and replays move nothing.
 */
export function nextConversationFacet(
  previous: StoredAgentConversation | undefined,
  previousRow: EnrichedAgentHookEventPayload | undefined,
  admitted: AgentHookEventPayload,
  reported: AgentProviderSessionMetadata | null,
  at: number
): StoredAgentConversation | undefined {
  const current = previous ?? seedConversationFromLegacyRow(previousRow)
  const admittedAgent = usableAgentType(admitted.payload.agentType)
  if (
    !reported ||
    !admittedAgent ||
    !admitted.providerSession ||
    // Why: a borrowed or substituted address is not this event's report.
    !conversationProviderSessionsEqual(admitted.providerSession, reported)
  ) {
    return current
  }
  const model = admitted.payload.model
  const modelSwitchCommand = admitted.payload.modelSwitchCommand
  if (
    current &&
    current.agentType === admittedAgent &&
    conversationProviderSessionsEqual(current.providerSession, admitted.providerSession)
  ) {
    if (!model || (model === current.model && modelSwitchCommand === current.modelSwitchCommand)) {
      return current
    }
    return {
      agentType: current.agentType,
      providerSession: current.providerSession,
      model,
      ...(modelSwitchCommand ? { modelSwitchCommand } : {}),
      capturedAt: at
    }
  }
  return {
    agentType: admittedAgent,
    providerSession: admitted.providerSession,
    ...(model ? { model } : {}),
    ...(modelSwitchCommand ? { modelSwitchCommand } : {}),
    capturedAt: at
  }
}
