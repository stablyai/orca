import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { isGrokEvent } from '../../../shared/agent-hook-listener/provider-event-names'
import type { EnrichedAgentHookEventPayload } from './server-types'

export function isStaleGrokTurnEnd(
  previous: EnrichedAgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload
): boolean {
  if (
    previous?.source !== 'grok' ||
    previous.payload.state === 'done' ||
    incoming.source !== 'grok' ||
    !isGrokEvent(incoming.hookEventName, 'stop', 'stop_failure', 'stop_cancelled') ||
    !incoming.providerPromptId
  ) {
    return false
  }

  if (!previous.providerPromptId) {
    return previous.grokPromptBoundary === true
  }

  const differentSession = Boolean(
    previous.providerSession?.id &&
    incoming.providerSession?.id &&
    previous.providerSession.id !== incoming.providerSession.id
  )

  return differentSession || previous.providerPromptId !== incoming.providerPromptId
}
