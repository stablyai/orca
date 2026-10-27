import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { rowHoldsOtherCodexThread } from '../../../shared/agent-hook-listener/providers/codex-ephemeral-threads'
import { isStaleGrokTurnEnd } from './server-grok-status-rules'
import type { EnrichedAgentHookEventPayload } from './server-types'

// A restarted relay may forward a Codex /side thread without its lost SessionStart; protect only a running main turn.
// SessionStart passes because the relay already filters it to new conversations.
function isRelayedCodexSideThreadHook(
  previous: EnrichedAgentHookEventPayload,
  incoming: AgentHookEventPayload
): boolean {
  const sessionId = incoming.providerSession?.id
  return Boolean(
    incoming.connectionId &&
    incoming.payload.agentType === 'codex' &&
    !incoming.toolAgentId &&
    incoming.hookEventName !== 'SessionStart' &&
    sessionId &&
    !incoming.providerSession?.transcriptPath &&
    previous.payload.state !== 'done' &&
    rowHoldsOtherCodexThread(previous, sessionId)
  )
}

/** A hook from a turn other than the one the row tracks, which must leave the row as it is. */
export function isForeignTurnHook(
  previous: EnrichedAgentHookEventPayload,
  incoming: AgentHookEventPayload
): boolean {
  return isStaleGrokTurnEnd(previous, incoming) || isRelayedCodexSideThreadHook(previous, incoming)
}
