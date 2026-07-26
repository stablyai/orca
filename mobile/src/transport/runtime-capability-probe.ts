import type { RpcClient } from './rpc-client'
import type { RpcSuccess } from './types'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

// Why: a relay→direct cutover or request timeout can reject an in-flight
// status.get without ever changing connState, so a one-shot probe would latch
// capability-gated UI hidden until the screen remounts; retry until one lands.
const CUTOVER_RETRY_DELAY_MS = 250
const FAILURE_RETRY_BASE_DELAY_MS = 1_000
const FAILURE_RETRY_MAX_DELAY_MS = 15_000

export function startRuntimeCapabilityProbe(
  client: RpcClient,
  onCapabilities: (capabilities: readonly string[]) => void
): () => void {
  let cancelled = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failureRetries = 0

  function attempt(): void {
    void client.sendRequest('status.get').then(
      (response) => {
        if (cancelled) {
          return
        }
        if (!response.ok) {
          scheduleRetry(false)
          return
        }
        const status = (response as RpcSuccess).result as { capabilities?: string[] }
        onCapabilities(status.capabilities ?? [])
      },
      (error: unknown) => {
        if (cancelled) {
          return
        }
        scheduleRetry(isLogicalClientCutoverError(error))
      }
    )
  }

  function scheduleRetry(cutover: boolean): void {
    // Why: cutover means the replacement transport is already authenticated —
    // re-ask promptly; other failures back off so a wedged host isn't hammered.
    const delay = cutover
      ? CUTOVER_RETRY_DELAY_MS
      : Math.min(FAILURE_RETRY_BASE_DELAY_MS * 2 ** failureRetries++, FAILURE_RETRY_MAX_DELAY_MS)
    retryTimer = setTimeout(attempt, delay)
  }

  attempt()
  return () => {
    cancelled = true
    if (retryTimer) {
      clearTimeout(retryTimer)
    }
  }
}
