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

/** A client restoring a pane on this host: replay what this host recorded for the pane, else
 *  the unrecorded rule with the mode this host's hooks saw. Undefined keeps the client's
 *  recorded Arguments, which clients send without the rest of the recipe. */
export function resolveSavedRestoreLaunchRecipe(args: {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
  record: SleepingAgentSessionRecord | undefined
  liveRow: AgentStatusIpcPayload | undefined
  clientAgentArgs: string | null | undefined
}): SleepingAgentLaunchConfig | undefined {
  const { agent } = args
  const sameSession = (session: AgentProviderSessionMetadata | null | undefined) =>
    session && agentProviderSessionsEqual(agent, session, args.providerSession) ? session : null
  const record = args.record?.agent === agent ? args.record : undefined
  const recorded = sameSession(record?.providerSession) ? record : undefined
  if (recorded?.launchConfig) {
    return resolveResumeLaunchRecipe(recorded.launchConfig, agent, recorded.providerSession)
  }
  if (args.clientAgentArgs !== undefined) {
    return undefined
  }
  const live =
    args.liveRow?.agentType === agent
      ? sameSession(normalizeAgentProviderSession(args.liveRow.providerSession))
      : null
  return resolveResumeLaunchRecipe(undefined, agent, live ?? recorded?.providerSession)
}
