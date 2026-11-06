import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import { resolveResumeLaunchRecipe } from '../../../../shared/agent-launch/choices/resume-launch-recipe'
import {
  agentProviderSessionsEqual,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'

/** A client restoring a pane this host ran: the host's note for that source pane, else the
 *  unrecorded rule with the mode this host's hooks saw there. Never this host's current settings,
 *  and never the client's partial Arguments: neither is the launch that ran. */
export function resolveSavedRestoreLaunchRecipe(args: {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
  /** The source pane's record and latest status on this host. */
  record: SleepingAgentSessionRecord | undefined
  liveRow: AgentStatusIpcPayload | undefined
}): SleepingAgentLaunchConfig {
  const { agent } = args
  const sameSession = (session: AgentProviderSessionMetadata | null | undefined) =>
    session && agentProviderSessionsEqual(agent, session, args.providerSession) ? session : null
  const recorded =
    args.record?.agent === agent && sameSession(args.record.providerSession)
      ? args.record
      : undefined
  if (recorded?.launchConfig) {
    return resolveResumeLaunchRecipe(recorded.launchConfig, agent, recorded.providerSession)
  }
  const live =
    args.liveRow?.agentType === agent
      ? sameSession(normalizeAgentProviderSession(args.liveRow.providerSession))
      : null
  return resolveResumeLaunchRecipe(undefined, agent, live ?? recorded?.providerSession)
}
