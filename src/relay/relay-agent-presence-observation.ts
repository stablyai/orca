import { randomUUID } from 'node:crypto'
import type { AgentHookEventPayload } from '../shared/agent-hook-listener/listener-event'

export function createRelayAgentPresenceObservation() {
  const epoch = randomUUID()
  let sequence = 0
  return (event: AgentHookEventPayload): AgentHookEventPayload => ({
    ...event,
    ...(event.agentPresence?.ended ? { providerSessionOnly: true } : {}),
    ...(event.agentPresence?.process
      ? { agentPresence: { ...event.agentPresence, observation: { epoch, sequence: ++sequence } } }
      : {})
  })
}
