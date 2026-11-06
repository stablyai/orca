import type { RpcClient } from './rpc-client'
import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'
import { hostStatusProbe, readProbedHostStatus } from './host-status-probe-operations'
import type { HostStatusReply } from './host-status-reply-schema'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

type ProbeClient = UnvalidatedRpcRequestPort &
  Partial<Pick<RpcClient, 'getGeneration' | 'getLastConnectedAt'>>
const observed = new WeakMap<object, { epoch: string; status: HostStatusReply | null }>()
export const runtimeStatusProbeEpoch = (client: ProbeClient) =>
  `${client.getGeneration?.()}:${client.getLastConnectedAt?.()}`
export function readRuntimeStatusProbe(client: ProbeClient): HostStatusReply | null | undefined {
  const entry = observed.get(client)
  return entry?.epoch === runtimeStatusProbeEpoch(client) ? entry.status : undefined
}

export function recordRuntimeStatusProbe(
  client: ProbeClient,
  status: HostStatusReply | null
): void {
  observed.set(client, { epoch: runtimeStatusProbeEpoch(client), status })
}

// Cutover/timeouts may reject status.get without a connection-state edge; retry until one answer lands.
const CUTOVER_RETRY_DELAY_MS = 250
const FAILURE_RETRY_BASE_DELAY_MS = 1_000
const FAILURE_RETRY_MAX_DELAY_MS = 15_000

// Deliver unreadable answers as null without retry; refusals/rejections retry and notify onAttemptFailed after scheduling.
// Accept the raw sender type because capability callers need not hold a full client.
export function startRuntimeStatusProbe(
  client: ProbeClient,
  onStatus: (status: HostStatusReply | null) => void,
  onAttemptFailed?: () => void
): () => void {
  const epoch = runtimeStatusProbeEpoch(client)
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
        if (epoch === runtimeStatusProbeEpoch(client)) {
          observed.set(client, { epoch, status: landed.status })
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
