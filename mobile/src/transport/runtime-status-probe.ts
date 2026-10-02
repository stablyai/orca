import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'
import { hostStatusProbe, readProbedHostStatus } from './host-status-probe-operations'
import type { HostStatusReply } from './host-status-reply-schema'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

// Why: a relay→direct cutover or request timeout can reject an in-flight
// status.get without ever changing connState, so a one-shot probe would latch
// its consumers on nothing until the screen remounts; retry until one lands.
const CUTOVER_RETRY_DELAY_MS = 250
const FAILURE_RETRY_BASE_DELAY_MS = 1_000
const FAILURE_RETRY_MAX_DELAY_MS = 15_000

/**
 * Asks status.get until an answer lands, then delivers it once and stops. `null` is a host that
 * answered something this build cannot decode — an answer, not a failure, so it is delivered
 * rather than retried. A refusal or transport rejection schedules a retry instead.
 *
 * `onAttemptFailed` runs on each refusal or rejection, once its retry is scheduled, for a caller
 * that must show something while the probe keeps asking.
 *
 * The parameter names the raw port rather than RpcClient because one of the capability callers
 * holds only the sender; the request itself goes through hostStatusProbe.
 */
export function startRuntimeStatusProbe(
  client: UnvalidatedRpcRequestPort,
  onStatus: (status: HostStatusReply | null) => void,
  onAttemptFailed?: () => void
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
        const landed = readProbedHostStatus(reply)
        if (!landed) {
          scheduleRetry(false)
          return
        }
        onStatus(landed.status)
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
    onAttemptFailed?.()
  }

  attempt()
  return () => {
    cancelled = true
    if (retryTimer) {
      clearTimeout(retryTimer)
    }
  }
}
