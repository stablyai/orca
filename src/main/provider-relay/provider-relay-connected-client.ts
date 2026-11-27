import type { DaemonClient } from '../daemon/transport/client/daemon-client'

const CONNECT_TIMEOUT_MS = 1_000

/** The client once it's connected within a second; null when it isn't (or there is none). */
export async function connectedRelayClient(
  client: DaemonClient | null
): Promise<DaemonClient | null> {
  if (!client) {
    return null
  }
  try {
    await client.ensureConnectedWithin(CONNECT_TIMEOUT_MS)
    return client
  } catch {
    return null
  }
}
