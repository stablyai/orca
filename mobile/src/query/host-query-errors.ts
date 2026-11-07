import { isLogicalClientSuspendedError } from '../transport/logical-client-suspended-error'
import { isRpcDeliveryUnknown } from '../transport/rpc-delivery-ambiguity'
import { isLogicalClientCutoverError } from '../transport/stable-logical-rpc-client'

const CUTOVER_RETRY_DELAY_MS = 250

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
  if (isRpcDeliveryUnknown(error) && !isHostNotConnectedError(error)) {
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
