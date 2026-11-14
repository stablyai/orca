import {
  runtimeHostStatusBlockedReason,
  type RuntimeHostStatusResponse
} from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RemoteRuntimeSharedConnectionDiagnostics } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-types'

/**
 * How long a paired server must go unanswered, with no answer in between, before Orca treats its
 * host as possibly gone (#34089). Minutes, like the SSH reconnect ladder running out: a network
 * blip or a server restart is answered well within it.
 */
export const RUNTIME_CONTACT_LOST_AFTER_MS = 3 * 60_000
const MIN_FAILED_CONTACTS = 3
/** Longest quiet spell between failures that still counts as one outage. Orca's slowest retry is
 *  5 minutes apart; a longer gap means it was not trying (the computer slept), so the old
 *  failures say nothing about now. */
const MAX_FAILURE_GAP_MS = 6 * 60_000

/** The dial failed or nothing answered: no evidence the server is there. */
const UNREACHED_CODES: ReadonlySet<string> = new Set([
  'remote_runtime_unavailable',
  'runtime_timeout',
  'runtime_unavailable'
])

type Outage = {
  since: number
  lastFailureAt: number
  failures: number
  /** The control socket's last counted reconnect attempt, so one attempt counts once. */
  reconnectAttempt?: number
}

/** Environment id → its current run of failed contacts. Only fed by dials Orca already makes. */
const outages = new Map<string, Outage>()

function noteReached(environmentId: string): void {
  outages.delete(environmentId)
}

function noteUnreached(environmentId: string, now: number, reconnectAttempt?: number): void {
  const outage = outages.get(environmentId)
  if (!outage || now - outage.lastFailureAt > MAX_FAILURE_GAP_MS) {
    outages.set(environmentId, { since: now, lastFailureAt: now, failures: 1, reconnectAttempt })
    return
  }
  if (reconnectAttempt !== undefined && reconnectAttempt === outage.reconnectAttempt) {
    return
  }
  outage.failures += 1
  outage.lastFailureAt = now
  if (reconnectAttempt !== undefined) {
    outage.reconnectAttempt = reconnectAttempt
  }
}

/** A health probe's outcome. A refusal (revoked pairing, replaced server) still came from the
 *  server, so it counts as reached; Orca's own refusals (asleep, disconnected) count as nothing. */
export function noteRuntimeEnvironmentStatusContact(
  environmentId: string,
  response: RuntimeHostStatusResponse,
  now = Date.now()
): void {
  if (response.ok || runtimeHostStatusBlockedReason(response)) {
    noteReached(environmentId)
  } else if (UNREACHED_CODES.has(response.error.code)) {
    noteUnreached(environmentId, now)
  }
}

/** The shared control socket's state: ready is an answer, each reconnect attempt is a failed
 *  contact (other diagnostics changes while reconnecting are not new attempts). */
export function noteRuntimeEnvironmentSharedControlContact(
  environmentId: string,
  diagnostics: Pick<RemoteRuntimeSharedConnectionDiagnostics, 'state' | 'reconnectAttempt'>,
  now = Date.now()
): void {
  if (diagnostics.state === 'ready') {
    noteReached(environmentId)
  } else if (diagnostics.state === 'reconnecting') {
    noteUnreached(environmentId, now, diagnostics.reconnectAttempt)
  }
}

/** Whether every contact with this server failed for minutes. Callers still rule out a server
 *  that is ready now or that the user disconnected. */
export function isRuntimeEnvironmentContactLost(environmentId: string, now = Date.now()): boolean {
  const outage = outages.get(environmentId)
  return (
    outage !== undefined &&
    outage.failures >= MIN_FAILED_CONTACTS &&
    now - outage.since >= RUNTIME_CONTACT_LOST_AFTER_MS &&
    now - outage.lastFailureAt <= MAX_FAILURE_GAP_MS
  )
}

/** A recovery brought the server back; its new connection starts with a clean record. */
export function clearRuntimeEnvironmentContactLoss(environmentId: string): void {
  outages.delete(environmentId)
}
