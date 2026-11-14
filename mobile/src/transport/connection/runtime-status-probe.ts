import type { HostStatusReply } from '../hosts/host-status-reply-schema'
import './stable-logical-rpc-client'
import { isLogicalClientCutoverError } from './logical-client-cutover-error'
import {
  connectionHostStatus,
  decodeHostStatusReply,
  directConnectionEpoch,
  hostConnectionEpoch,
  sendHostStatusRead,
  type HostStatusClient
} from '../../query/host-status-query'

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
const sharedProbes = new WeakMap<object, SharedProbe>()
export function readRuntimeStatusProbe(
  client: HostStatusClient
): HostStatusReply | null | undefined {
  const entry = observed.get(client)
  return entry?.epoch === hostConnectionEpoch(client) ? entry.status : undefined
}

/** The status this connection already received, or undefined when it may not stand in for a new read. */
export function readConnectionStatusProbe(client: HostStatusClient): HostStatusReply | undefined {
  return connectionHostStatus(client)?.status
}

export function recordRuntimeStatusProbe(
  client: HostStatusClient,
  status: HostStatusReply | null
): void {
  observed.set(client, { epoch: hostConnectionEpoch(client), status })
}

// Cutover/timeouts may reject status.get without a connection-state edge; retry until one answer lands.
const CUTOVER_RETRY_DELAY_MS = 250
const FAILURE_RETRY_BASE_DELAY_MS = 1_000
const FAILURE_RETRY_MAX_DELAY_MS = 15_000

// Deliver unreadable answers as null without retry; refusals/rejections retry and notify onAttemptFailed after scheduling.
// Accept the raw sender type because capability callers need not hold a full client.
export function startRuntimeStatusProbe(
  client: HostStatusClient,
  onStatus: (status: HostStatusReply | null) => void,
  onAttemptFailed?: () => void
): () => void {
  const epoch = directConnectionEpoch(client)
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

function startSharedProbe(client: HostStatusClient, epoch: string): SharedProbe {
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
  client: HostStatusClient,
  listener: ProbeListener
): { retryNow: () => void; stop: () => void } {
  const epoch = hostConnectionEpoch(client)
  let cancelled = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  let failureRetries = 0

  function attempt(): void {
    retryTimer = null
    void sendHostStatusRead(client).then(
      (reply) => {
        if (cancelled) {
          return
        }
        const landed = decodeHostStatusReply(reply)
        if (!landed) {
          scheduleRetry(false)
          return
        }
        if (epoch === hostConnectionEpoch(client)) {
          observed.set(client, { epoch, status: landed.status })
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
