import type { RpcClient } from './rpc-client'
import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'
import { hostStatusProbe, readProbedHostStatus } from './host-status-probe-operations'
import type { HostStatusReply } from './host-status-reply-schema'
import { isLogicalClientCutoverError } from './stable-logical-rpc-client'

type ProbeClient = UnvalidatedRpcRequestPort &
  Partial<Pick<RpcClient, 'getGeneration' | 'getLastConnectedAt' | 'requestRoute'>>
type ProbeListener = {
  onStatus: (status: HostStatusReply | null) => void
  onAttemptFailed?: () => void
}
type SharedProbe = {
  epoch: string
  listeners: Set<ProbeListener>
  retryNow: () => void
  stop: () => void
}
type EpochStatus = { epoch: string; status: HostStatusReply | null }
const observed = new WeakMap<object, EpochStatus>()
// Only answers this probe received; recorded proofs may merge in capabilities from an earlier read.
const probed = new WeakMap<object, EpochStatus>()
const sharedProbes = new WeakMap<object, SharedProbe>()
export const runtimeStatusProbeEpoch = (client: ProbeClient) =>
  `${client.getGeneration?.()}:${client.getLastConnectedAt?.()}`
export function readRuntimeStatusProbe(client: ProbeClient): HostStatusReply | null | undefined {
  const entry = observed.get(client)
  return entry?.epoch === runtimeStatusProbeEpoch(client) ? entry.status : undefined
}

// Why: a routed view answers status.get from a server behind the desktop, which can restart or reconnect while
// this connection stays up, and a client with no connect time has no epoch to hold an answer to.
function connectionEpoch(client: ProbeClient): string | null {
  return client.requestRoute === undefined && typeof client.getLastConnectedAt?.() === 'number'
    ? runtimeStatusProbeEpoch(client)
    : null
}

/** The status this connection already proved, or undefined when it may not stand in for a new read. */
export function readConnectionStatusProbe(client: ProbeClient): HostStatusReply | null | undefined {
  const epoch = connectionEpoch(client)
  const entry = probed.get(client)
  return epoch !== null && entry?.epoch === epoch ? entry.status : undefined
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
  const epoch = connectionEpoch(client)
  if (epoch === null) {
    return runProbe(client, { onStatus, onAttemptFailed }).stop
  }
  // Join a read already in flight; a new start after one landed reads again, since capabilities like
  // screencast follow the desktop's window and settings, not the connection.
  const running = sharedProbes.get(client)
  const joined = running?.epoch === epoch ? running : startSharedProbe(client, epoch)
  if (joined === running) {
    // A new reader should not wait out a backoff it never saw fail.
    joined.retryNow()
  }
  const listener: ProbeListener = { onStatus, onAttemptFailed }
  joined.listeners.add(listener)
  return () => {
    if (!joined.listeners.delete(listener) || joined.listeners.size > 0) {
      return
    }
    joined.stop()
    if (sharedProbes.get(client) === joined) {
      sharedProbes.delete(client)
    }
  }
}

function startSharedProbe(client: ProbeClient, epoch: string): SharedProbe {
  const listeners = new Set<ProbeListener>()
  const each = (notify: (listener: ProbeListener) => void) => [...listeners].forEach(notify)
  const probe: SharedProbe = {
    epoch,
    listeners,
    ...runProbe(client, {
      onStatus: (status) => {
        if (sharedProbes.get(client) === probe) {
          sharedProbes.delete(client)
        }
        each((listener) => listener.onStatus(status))
      },
      onAttemptFailed: () => each((listener) => listener.onAttemptFailed?.())
    })
  }
  sharedProbes.set(client, probe)
  return probe
}

function runProbe(
  client: ProbeClient,
  listener: ProbeListener
): { retryNow: () => void; stop: () => void } {
  const epoch = runtimeStatusProbeEpoch(client)
  let cancelled = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failureRetries = 0

  function attempt(): void {
    retryTimer = null
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
          const entry = { epoch, status: landed.status }
          observed.set(client, entry)
          probed.set(client, entry)
        }
        listener.onStatus(landed.status)
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
    listener.onAttemptFailed?.()
  }

  attempt()
  return {
    retryNow: () => {
      if (retryTimer) {
        clearTimeout(retryTimer)
        attempt()
      }
    },
    stop: () => {
      cancelled = true
      if (retryTimer) {
        clearTimeout(retryTimer)
      }
    }
  }
}
