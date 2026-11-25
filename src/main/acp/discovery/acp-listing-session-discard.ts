import type { AcpListingSession, AcpSessionModelDiscovery } from './acp-model-discovery-policy'
import type { ProviderAcquisitionConnection } from '../../provider-process/provider-acquisition-starts'
import { waitForProcessExitUntil } from '../../provider-process/provider-process-exit-deadline'

const LISTING_EXIT_WAIT_MS = 5_000

/** Runs after the listing process exits, so the agent no longer writes the sessions it removes. A
 *  close can return once the kill is sent, so only a listing with sessions to remove waits for the
 *  exit itself (at most LISTING_EXIT_WAIT_MS). */
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
    const exited = new Promise<void>((resolve) => listingProcess.onExit(resolve))
    await waitForProcessExitUntil(exited, LISTING_EXIT_WAIT_MS)
  }
  for (const sessionId of sessionIds) {
    await listing.discardSession({ ...session, sessionId }).catch((error: unknown) => {
      console.warn(`[acp-model-catalog] ${agent} kept a listing session:`, error)
    })
  }
}
