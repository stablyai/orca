import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status/contracts/agent-status-observation'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/resume/agent-provider-session-equality'
import { sameAgentStatusTerminalOwner } from '../../../shared/agent-status/identity/agent-status-terminal-owner'

/** Resume startup reports keep the conversation's accepted verdict until a new turn. */
export function resumedAcceptedTurn(
  previous: EnrichedAgentHookEventPayload,
  incoming: AgentHookEventPayload,
  origin: AgentStatusObservationOrigin
): EnrichedAgentHookEventPayload | null {
  const continuesTurn =
    (incoming.payload.agentType === 'claude' || previous.observation?.origin === 'launch') &&
    (incoming.payload.sessionBoundary === true ||
      (origin === 'osc' && previous.observation?.origin === 'launch')) &&
    // Terminal work after a resume is shown as it is on main; only restated verdicts continue.
    incoming.payload.state === 'done' &&
    incoming.toolAgentId === undefined &&
    !endsAnotherTurn(previous, incoming) &&
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
    executionHost: previousHost,
    ...accepted
  } = previous
  // The host follows the binding: a resuming hook's own binding brings its own host.
  const executionHost =
    incoming.executionHost ??
    (!incoming.providerSession || incoming.providerSession === previous.providerSession
      ? previousHost
      : undefined)
  return {
    ...accepted,
    connectionId: incoming.connectionId,
    ...(incoming.providerSession ? { providerSession: incoming.providerSession } : {}),
    ...(incoming.agentPresence ? { agentPresence: incoming.agentPresence } : {}),
    ...(incoming.terminalHandle ? { terminalHandle: incoming.terminalHandle } : {}),
    ...(executionHost ? { executionHost } : {})
  }
}

/** A completion stamped with its own turn end is a later turn, not a restatement. */
function endsAnotherTurn(
  previous: EnrichedAgentHookEventPayload,
  incoming: AgentHookEventPayload
): boolean {
  return (
    (incoming.turnEndedAt !== undefined && incoming.turnEndedAt !== previous.turnEndedAt) ||
    (incoming.payload.turnCompletedAt !== undefined &&
      incoming.payload.turnCompletedAt !== previous.payload.turnCompletedAt)
  )
}

export function resolvedHookAgentType<T extends AgentHookEventPayload>(
  row: T,
  agentType: AgentHookEventPayload['payload']['agentType']
): T {
  return row.payload.agentType === agentType
    ? row
    : { ...row, payload: { ...row.payload, agentType } }
}
