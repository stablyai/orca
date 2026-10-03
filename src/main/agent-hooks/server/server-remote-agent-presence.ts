import {
  isSameAgentProcess,
  readAgentProcessPresence,
  type AgentPaneOwner,
  type AgentProcessPresence
} from '../../../shared/agent-process-presence'

/** The envelope's owner claim, marked host-decided only when its relay stamped and ordered it. */
export function admitRemoteAgentPresence(
  envelope: { agentPresence?: unknown },
  connectionId: string | null,
  recorded: AgentPaneOwner | undefined
): { agentPresence?: AgentProcessPresence; agentPresenceFromExecutionHost?: true } | null {
  const agentPresence = readAgentProcessPresence(envelope.agentPresence)
  const observation = agentPresence?.observation
  if (!connectionId || !observation || !agentPresence?.process) {
    return { agentPresence }
  }
  const recordedObservation = recorded?.presence.observation
  const sameConnection = recorded?.connectionId === connectionId
  if (
    sameConnection &&
    recordedObservation?.epoch === observation.epoch &&
    recordedObservation.sequence > observation.sequence
  ) {
    return null
  }
  if (
    sameConnection &&
    recordedObservation?.epoch === observation.epoch &&
    recordedObservation.sequence === observation.sequence &&
    recorded?.presence.process &&
    (!isSameAgentProcess(recorded.presence.process, agentPresence.process) ||
      recorded.presence.ended !== agentPresence.ended)
  ) {
    return null
  }
  return {
    agentPresence,
    agentPresenceFromExecutionHost: true
  }
}
