import { BridgeReplyRefusedError } from '../mobile-web-shell/bridge/bridge-client-errors'
import { isLogicalClientSuspendedError } from '../transport/connection/logical-client-suspended-error'
import { isRpcDeliveryUnknown } from '../transport/rpc/rpc-delivery-ambiguity'
import '../transport/connection/stable-logical-rpc-client'
import { isLogicalClientCutoverError } from '../transport/connection/logical-client-cutover-error'
import { GITHUB_CONNECTION_CHANGED } from '../source-control/review/github-operations/github-target-invocation'

export const CUTOVER_RETRY_DELAY_MS = 250

// failWhenDisconnected rejects with a plain Error that the page bridge rebuilds, so match the message.
export function isHostNotConnectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.startsWith('Not connected:') || isLogicalClientSuspendedError(error))
  )
}

// A path switch or a lost reply may succeed on a second try; a disconnect waits for the connected edge instead.
// A lost read retries at once: if the host went away, failWhenDisconnected ends it without waiting.
function retryDelayFor(error: unknown): number | null {
  if (isLogicalClientCutoverError(error)) {
    return CUTOVER_RETRY_DELAY_MS
  }
  // The shell refused an unreadable reply: a second read gets the same answer.
  if (error instanceof BridgeReplyRefusedError) {
    return null
  }
  if (isRpcDeliveryUnknown(error) && !isHostNotConnectedError(error)) {
    return 0
  }
  // A GitHub read whose path or account check moved mid-read (a LAN/relay switch) sent nothing; the connected
  // edge never fires for that switch, so the read starts again at once on the new path.
  if (error instanceof Error && error.message === GITHUB_CONNECTION_CHANGED) {
    return 0
  }
  return null
}

export function shouldRetryHostQuery(failureCount: number, error: unknown): boolean {
  return failureCount === 0 && retryDelayFor(error) !== null
}

export function hostQueryRetryDelay(_failureCount: number, error: unknown): number {
  return retryDelayFor(error) ?? 0
}
