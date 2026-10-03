import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import {
  isSameAgentProcess,
  readAgentProcessPresence
} from '../../../shared/agent-process-presence'

export function admitRemoteAgentPresence(
  envelope: { agentPresence?: unknown },
  connectionId: string | null,
  previous: AgentHookEventPayload | undefined
): Pick<AgentHookEventPayload, 'agentPresence' | 'agentPresenceFromExecutionHost'> | null {
  const agentPresence = readAgentProcessPresence(envelope.agentPresence)
  const observation = agentPresence?.observation
  if (!connectionId || !observation || !agentPresence?.process) {
    return { agentPresence }
  }
  const recorded = previous?.agentPresence?.observation
  if (
    previous?.connectionId === connectionId &&
    recorded?.epoch === observation.epoch &&
    recorded.sequence > observation.sequence
  ) {
    return null
  }
  if (
    recorded?.epoch === observation.epoch &&
    recorded.sequence === observation.sequence &&
    previous?.connectionId === connectionId &&
    previous.agentPresence?.process &&
    (!isSameAgentProcess(previous.agentPresence.process, agentPresence.process) ||
      previous.agentPresence.ended !== agentPresence.ended)
  ) {
    return null
  }
  return {
    agentPresence,
    agentPresenceFromExecutionHost: true
  }
}
