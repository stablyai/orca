import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { EnrichedAgentHookEventPayload } from './server-types'

/** Preserve root-only resume fields when a relay restart delivers a child event first. */
export function preserveCodexRootContext(
  payload: AgentHookEventPayload,
  previous: EnrichedAgentHookEventPayload | undefined
): AgentHookEventPayload {
  if (
    payload.payload.agentType !== 'codex' ||
    !payload.toolAgentId ||
    previous?.payload.agentType !== 'codex'
  ) {
    return payload
  }
  const providerSession = payload.providerSession ?? previous.providerSession
  const model = payload.payload.model ?? previous.payload.model
  return providerSession || model
    ? {
        ...payload,
        ...(providerSession ? { providerSession } : {}),
        payload: model ? { ...payload.payload, model } : payload.payload
      }
    : payload
}
