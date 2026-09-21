import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'
import { hostStatusProbe, readProbedHostCapabilities } from './host-status-probe-operations'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

// Why: a relay→direct cutover or request timeout can reject an in-flight
// status.get without ever changing connState, so a one-shot probe would latch
// capability-gated UI hidden until the screen remounts; retry until one lands.
const CUTOVER_RETRY_DELAY_MS = 250
const FAILURE_RETRY_BASE_DELAY_MS = 1_000
const FAILURE_RETRY_MAX_DELAY_MS = 15_000

// The parameter names the raw port rather than RpcClient because one of the four callers holds
// only the sender; the request itself goes through hostStatusProbe.
export function startRuntimeCapabilityProbe(
  client: UnvalidatedRpcRequestPort,
  onCapabilities: (capabilities: readonly string[]) => void
): () => void {
  let cancelled = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failureRetries = 0

  function attempt(): void {
    void hostStatusProbe.request(client).then(
      (reply) => {
        if (cancelled) {
          return
        }
        const capabilities = readProbedHostCapabilities(reply)
        if (!capabilities) {
          scheduleRetry(false)
          return
        }
        onCapabilities(capabilities)
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
