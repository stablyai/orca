import {
  agentSessionAccountHomePath,
  type AgentSessionAccountHome
} from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'
import type { AcpListingSession, AcpSessionModelDiscovery } from './acp-model-discovery-policy'

/** Deletes listing sessions after their process exits; a failure leaves the catalog result. */
export async function discardAcpListingSessions(
  agent: string,
  listing: AcpSessionModelDiscovery,
  sessionIds: readonly string[],
  session: Omit<AcpListingSession, 'sessionId' | 'accountHomePath'> & {
    accountHome: AgentSessionAccountHome
  }
): Promise<void> {
  const accountHomePath = agentSessionAccountHomePath(session.accountHome)
  if (!accountHomePath || !listing.discardSession || sessionIds.length === 0) {
    return
  }
  for (const sessionId of sessionIds) {
    await listing
      .discardSession({
        sessionId,
        cwd: session.cwd,
        launchCwd: session.launchCwd,
        accountHomePath,
        command: session.command,
        prefixArgs: session.prefixArgs,
        env: session.env,
        envToDelete: session.envToDelete
      })
      .catch((error: unknown) => {
        console.warn(`[acp-model-catalog] ${agent} kept a listing session:`, error)
      })
  }
}
