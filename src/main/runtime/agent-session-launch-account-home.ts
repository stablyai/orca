import { claudeProfileRoutingEnabled } from '../../shared/claude-profile-routing'
import type { AgentSessionAccountHome, AgentSessionRecord } from '../../shared/agent-session-record'

/** The home the session's process runs under, for its launch fallback and model catalog alike. */
export function agentSessionLaunchAccountHome(
  record: Pick<AgentSessionRecord, 'accountHome' | 'launchAccountHome'>
): AgentSessionAccountHome {
  return (claudeProfileRoutingEnabled() && record.launchAccountHome) || record.accountHome
}
