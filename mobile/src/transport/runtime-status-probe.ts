import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'
import { hostStatusProbe, readProbedHostStatus } from './host-status-probe-operations'
import type { HostStatusReply } from './host-status-reply-schema'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

// Cutover/timeouts may reject status.get without a connection-state edge; retry until one answer lands.
const CUTOVER_RETRY_DELAY_MS = 250
const FAILURE_RETRY_BASE_DELAY_MS = 1_000
const FAILURE_RETRY_MAX_DELAY_MS = 15_000

// Deliver unreadable answers as null without retry; refusals/rejections retry and notify onAttemptFailed after scheduling.
// Accept the raw sender type because capability callers need not hold a full client.
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
    // Cutover already authenticated a replacement; retry promptly while backing off other failures.
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
