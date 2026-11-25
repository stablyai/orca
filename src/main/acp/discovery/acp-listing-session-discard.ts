import type { AcpListingSession, AcpSessionModelDiscovery } from './acp-model-discovery-policy'
import type { ProviderAcquisitionConnection } from '../../provider-process/provider-acquisition-starts'
import { waitForProviderExitUntil } from '../../provider-process/provider-process-exit-deadline'

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
