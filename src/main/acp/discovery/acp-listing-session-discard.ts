import type { AcpListingSession, AcpSessionModelDiscovery } from './acp-model-discovery-policy'

/** Runs after the listing process exits, so the agent no longer writes the sessions it removes. */
export async function discardAcpListingSessions(
  agent: string,
  listing: AcpSessionModelDiscovery,
  sessionIds: readonly string[],
  session: Omit<AcpListingSession, 'sessionId'>
): Promise<void> {
  for (const sessionId of sessionIds) {
    await listing.discardSession?.({ ...session, sessionId }).catch((error: unknown) => {
      console.warn(`[acp-model-catalog] ${agent} kept a listing session:`, error)
    })
  }
}
