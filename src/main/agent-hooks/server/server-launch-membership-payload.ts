import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status-observation'
import type { EnrichedAgentHookEventPayload } from './server-types'

/**
 * Keep launch membership host-owned while carrying it across a verified terminal owner.
 */
export function prepareLaunchMembershipPayload(args: {
  payload: AgentHookEventPayload
  origin: AgentStatusObservationOrigin
  previous?: EnrichedAgentHookEventPayload
  sameTerminalOwner: (
    previous: EnrichedAgentHookEventPayload,
    incoming: Pick<AgentHookEventPayload, 'connectionId' | 'worktreeId'>
  ) => boolean
}): AgentHookEventPayload {
  const { payload, origin, previous, sameTerminalOwner } = args
  const { launchMembership: incomingLaunchMembership, ...payloadWithoutMembership } = payload
  const launchOwnedPayload: AgentHookEventPayload =
    origin === 'launch' && incomingLaunchMembership
      ? { ...payloadWithoutMembership, launchMembership: incomingLaunchMembership }
      : payloadWithoutMembership
  const terminalHandle =
    launchOwnedPayload.terminalHandle ??
    (previous?.terminalHandle && sameTerminalOwner(previous, launchOwnedPayload)
      ? previous.terminalHandle
      : undefined)
  const terminalOwnedPayload =
    terminalHandle === launchOwnedPayload.terminalHandle
      ? launchOwnedPayload
      : { ...launchOwnedPayload, terminalHandle }
  const carriedLaunchMembership =
    terminalOwnedPayload.launchMembership ??
    (previous &&
    previous.launchMembership &&
    previous.terminalHandle &&
    terminalHandle === previous.terminalHandle &&
    sameTerminalOwner(previous, terminalOwnedPayload)
      ? previous.launchMembership
      : undefined)
  return carriedLaunchMembership
    ? { ...terminalOwnedPayload, launchMembership: carriedLaunchMembership }
    : terminalOwnedPayload
}
