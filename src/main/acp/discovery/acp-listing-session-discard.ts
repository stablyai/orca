import type { AcpListingSession, AcpSessionModelDiscovery } from './acp-model-discovery-policy'
import type { ProviderAcquisitionConnection } from '../../provider-process/provider-acquisition-starts'
import { waitForProviderExitUntil } from '../../provider-process/provider-process-exit-deadline'
import {
  runAgentModelCatalogListing,
  type AgentModelCatalogListingLaunch
} from '../../native-chat/agent-model-catalog/agent-model-catalog-probe-runner'
import {
  agentSessionAccountHomePath,
  type AgentSessionAccountHome
} from '../../../shared/agent-session/lifecycle/accounts/agent-session-account-home'

const LISTING_EXIT_WAIT_MS = 5_000

/** Runs after the listing process exits (waiting at most LISTING_EXIT_WAIT_MS), so the agent no
 *  longer writes the sessions it removes; a listing with none to remove doesn't wait. */
export async function discardAcpListingSessions(
  agent: string,
  listing: AcpSessionModelDiscovery,
  sessionIds: readonly string[],
  listingProcess: Pick<ProviderAcquisitionConnection, 'onExit'> | undefined,
  session: Omit<AcpListingSession, 'sessionId'>
): Promise<void> {
  if (!listing.discardSession || sessionIds.length === 0) {
    return
  }
  if (listingProcess) {
    await waitForProviderExitUntil(listingProcess, LISTING_EXIT_WAIT_MS)
  }
  for (const sessionId of sessionIds) {
    await listing.discardSession({ ...session, sessionId }).catch((error: unknown) => {
      console.warn(`[acp-model-catalog] ${agent} kept a listing session:`, error)
    })
  }
}

/** The listing's discard, run with its own binary, account and environment; null when the agent
 *  keeps no session to remove or the account has no home folder. */
export function acpListingSessionDiscard(
  agent: string,
  listing: AcpSessionModelDiscovery,
  accountHome: AgentSessionAccountHome,
  /** Where the listing's session ran. */
  cwd: string,
  launch: Omit<AgentModelCatalogListingLaunch, 'args'> & { prefixArgs: readonly string[] },
  runListing: typeof runAgentModelCatalogListing = runAgentModelCatalogListing
):
  | ((
      sessionIds: readonly string[],
      listingProcess?: Pick<ProviderAcquisitionConnection, 'onExit'>
    ) => Promise<void>)
  | null {
  const accountHomePath = listing.discardSession ? agentSessionAccountHomePath(accountHome) : null
  if (!accountHomePath) {
    return null
  }
  const { prefixArgs, ...base } = launch
  return (sessionIds, listingProcess) =>
    discardAcpListingSessions(agent, listing, sessionIds, listingProcess, {
      cwd,
      accountHomePath,
      // Unbounded by the listing's signal: a cancelled listing still discards its session.
      runAgent: (agentArgs) =>
        runListing(
          { ...base, args: [...prefixArgs, ...agentArgs] },
          { site: `${agent}-listing-discard` }
        )
    })
}
