import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** A later row of the same agent keeps the facet only the host producer writes; another agent drops it. */
export function carriedRunAccount(
  previous: EnrichedAgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload & Pick<EnrichedAgentHookEventPayload, 'runAccount'>
): Pick<EnrichedAgentHookEventPayload, 'runAccount'> {
  if (incoming.runAccount !== undefined) {
    return { runAccount: incoming.runAccount }
  }
  return previous?.runAccount !== undefined &&
    previous.payload.agentType === incoming.payload.agentType &&
    previous.connectionId === incoming.connectionId
    ? { runAccount: previous.runAccount }
    : {}
}
