import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { sameAgentStatusTerminalOwner } from '../../../shared/agent-status/identity/agent-status-terminal-owner'

/** A boundary for the conversation whose turn the pane last accepted keeps that turn's verdict. */
export function resumedAcceptedTurn(
  previous: EnrichedAgentHookEventPayload,
  incoming: AgentHookEventPayload
): EnrichedAgentHookEventPayload | null {
  const continuesTurn =
    (incoming.payload.agentType === 'claude' || previous.payload.interrupted === true) &&
    incoming.payload.sessionBoundary === true &&
    incoming.hasExplicitPrompt !== true &&
    incoming.toolAgentId === undefined &&
    previous.payload.state === 'done' &&
    previous.payload.sessionBoundary !== true &&
    previous.providerSessionOnly !== true &&
    previous.paneSleep === undefined &&
    previous.providerSession !== undefined &&
    previous.payload.agentType === incoming.payload.agentType &&
    sameAgentStatusTerminalOwner(previous, incoming) &&
    agentProviderSessionsEqual(
      incoming.payload.agentType,
      previous.providerSession,
      incoming.providerSession
    )
  if (!continuesTurn) {
    return null
  }
  const { agentPresence: _sleptOwner, restoredUnconfirmed: _restored, ...accepted } = previous
  return {
    ...accepted,
    ...(incoming.providerSession ? { providerSession: incoming.providerSession } : {}),
    ...(incoming.agentPresence ? { agentPresence: incoming.agentPresence } : {})
  }
}

export function resolvedHookAgentType<T extends AgentHookEventPayload>(
  row: T,
  agentType: AgentHookEventPayload['payload']['agentType']
): T {
  return row.payload.agentType === agentType
    ? row
    : { ...row, payload: { ...row.payload, agentType } }
}
