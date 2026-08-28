/* Asks the question a user would: can anything actually be reached at the endpoint?
   Tests must not use file existence for this — a shut-down daemon deliberately leaves its
   socket entry behind for the next publisher to replace. */
import { probeSocketConnect } from './daemon-endpoint-probe'

const ENDPOINT_UNREACHABLE_TIMEOUT_MS = 2_000
const ENDPOINT_POLL_MS = 20

/**
 * Why reuse the production probe: it is the same classifier the daemon publishes against, so a
 * test cannot drift from what the daemon itself treats as a reachable endpoint.
 */
export async function waitForEndpointUnreachable(socketPath: string): Promise<boolean> {
  const deadline = Date.now() + ENDPOINT_UNREACHABLE_TIMEOUT_MS
  while ((await probeSocketConnect(socketPath)) === 'connected') {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, ENDPOINT_POLL_MS))
  }
  return true
}
