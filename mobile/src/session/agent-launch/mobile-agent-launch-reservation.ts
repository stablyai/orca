import { AGENT_LAUNCH_PLAIN_SESSION_ID_RUNTIME_CAPABILITY } from '../../../../src/shared/agent-launch/contracts/agent-launch-runtime-capability'
import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { createOrcaSessionId } from '../../../../src/shared/agent-session/identity/orca-session-address'
import { isStructuredAgentId } from '../../../../src/shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { makePaneKey } from '../../../../src/shared/workspace-layout/stable-pane-id'

// Reserve ids once so snapshots can select the new tab before prompt delivery replies; replays must reuse both ids covered by the host fingerprint.
export type MobileAgentLaunchReservation = {
  pane: { tabId: string; leafId: string }
  sessionId: string | null
}

export function reserveMobileAgentLaunch(
  agent: TuiAgent,
  hostCapabilities: readonly string[] | null | undefined,
  randomUuid: () => string
): MobileAgentLaunchReservation {
  return {
    pane: { tabId: randomUuid(), leafId: randomUuid() },
    sessionId: !isStructuredAgentId(agent)
      ? null
      : hostCapabilities?.includes(AGENT_LAUNCH_PLAIN_SESSION_ID_RUNTIME_CAPABILITY)
        ? createOrcaSessionId(randomUuid)
        : agentPrefixedSessionId(agent, randomUuid)
  }
}

/** The reservation as `agent.launchReplay` fields. */
export function reservedAgentLaunchFields(reservation: MobileAgentLaunchReservation) {
  return {
    paneKey: makePaneKey(reservation.pane.tabId, reservation.pane.leafId),
    ...(reservation.sessionId ? { sessionId: reservation.sessionId } : {})
  }
}

// Older hosts refuse any other reserved spelling; delete once the phone's minimum supported host
// advertises AGENT_LAUNCH_PLAIN_SESSION_ID_RUNTIME_CAPABILITY.
function agentPrefixedSessionId(agent: TuiAgent, randomUuid: () => string): string {
  return `${agent}_${randomUuid().replaceAll('-', '_')}`
}
