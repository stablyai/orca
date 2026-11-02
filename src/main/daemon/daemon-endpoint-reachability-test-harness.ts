// Probe reachability: stopped daemons deliberately leave socket entries behind.
import { probeSocketConnect } from './daemon-endpoint-probe'

const ENDPOINT_UNREACHABLE_TIMEOUT_MS = 2_000
const ENDPOINT_POLL_MS = 20

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
