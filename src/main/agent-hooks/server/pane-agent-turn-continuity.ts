import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status/contracts/agent-status-observation'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { sameAgentStatusTerminalOwner } from '../../../shared/agent-status/identity/agent-status-terminal-owner'

/** Resume startup reports keep the conversation's accepted verdict until a new turn. */
export function resumedAcceptedTurn(
  previous: EnrichedAgentHookEventPayload,
  incoming: AgentHookEventPayload,
  origin: AgentStatusObservationOrigin,
  /** No user submission since the launch: terminal work is still the CLI's own startup. */
  startupOpen = true
): EnrichedAgentHookEventPayload | null {
  const continuesTurn =
    (incoming.payload.agentType === 'claude' || previous.observation?.origin === 'launch') &&
    (incoming.payload.sessionBoundary === true ||
      (origin === 'osc' && previous.observation?.origin === 'launch')) &&
    (incoming.payload.state === 'done' ||
      (origin === 'osc' && incoming.payload.state === 'working' && startupOpen)) &&
    incoming.toolAgentId === undefined &&
    previous.payload.state === 'done' &&
    previous.payload.sessionBoundary !== true &&
    previous.providerSessionOnly !== true &&
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
  const {
    agentPresence: _sleptOwner,
    restoredUnconfirmed: _restored,
    paneSleep: _sleep,
    ...accepted
  } = previous
  return {
    ...accepted,
    ...(incoming.providerSession ? { providerSession: incoming.providerSession } : {}),
    ...(incoming.agentPresence ? { agentPresence: incoming.agentPresence } : {}),
    ...(incoming.terminalHandle ? { terminalHandle: incoming.terminalHandle } : {})
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
