import type { ControlPlaneStore, LivenessMarkerRow } from './control-plane-store'
import type { CoordinatorWakeReason } from './coordinator-wake-events'

/** B4 — liveness is owned by the runtime, never by a model heartbeat.
 *
 *  Authoritative clock: the runtime's wall clock, passed in as `nowMs`. No
 *  model-generated timestamp is ever read.
 *  Persisted marker: `control_plane_dispatch_liveness`, one row per Dispatch.
 *  Writer: `sweepDispatchLiveness` (runtime). Consumer: the wake planner and
 *  the B10 state query. Nothing else writes it.
 *  Expiry / re-arm: every sweep rewrites `expires_at = observed_at + ttl`. A
 *  marker whose `expires_at` has passed reads as `unverifiable`, so a dead
 *  sweep degrades to "cannot confirm", never to a false `live`.
 *  Terminal resolver: `crashed` and `settled` set `terminal = 1`; the store's
 *  upsert refuses to overwrite a terminal row, so a late sweep cannot resurrect
 *  a settled Dispatch.
 *  Idempotency / concurrency: the marker is keyed by dispatch_id and every
 *  write is a single upsert, so concurrent sweeps converge; a wake is emitted
 *  only on the transition INTO stalled/crashed (`woke_for` records which), so
 *  repeated sweeps in the same state never re-wake the coordinator.
 *  Crash recovery: markers are rebuilt from process/session evidence on the
 *  next sweep; nothing durable depends on the previous marker except the
 *  transition test, which fails safe by re-waking once.
 */

export type LivenessEvidence = {
  /** Process/session state as the execution host reports it. */
  processState: 'running' | 'exited' | 'unknown'
  /** Last output or activity observed on the worker session, ISO-8601 or null. */
  lastActivityAt: string | null
  /** True while the worker is inside a tool call the runtime can see. */
  activeToolCall: boolean
  /** Set while the worker sits in an Orca-approved blocking wait (ask/check). */
  approvedBlockingWaitUntil: string | null
  /** Provider process exit, when the host established one. */
  providerExit: { code: number | null; signal: string | null } | null
  terminalState: 'attached' | 'detached' | 'closed'
  /** True once the Dispatch has a settled lifecycle row. */
  settled?: boolean
}

/** The SSH execution boundary vocabulary. Loss of contact is `unverifiable`,
 *  never `exited`. See docs/reference/ssh-execution-boundary.md. */
export type LivenessVerdict = 'live' | 'unverifiable' | 'exited'

export type LivenessActivity =
  | 'working'
  | 'blocked_on_approved_wait'
  | 'stalled'
  | 'crashed'
  | 'settled'

export type LivenessClassification = {
  verdict: LivenessVerdict
  activity: LivenessActivity
  reason: string
  terminal: boolean
}

export type LivenessPolicy = {
  /** Silence beyond this with no tool call and no approved wait is a stall. */
  stallAfterMs: number
  /** How long a written marker stays authoritative before it reads as stale. */
  markerTtlMs: number
}

export const DEFAULT_LIVENESS_POLICY: LivenessPolicy = {
  stallAfterMs: 10 * 60 * 1000,
  markerTtlMs: 5 * 60 * 1000
}

export function classifyDispatchLiveness(
  evidence: LivenessEvidence,
  nowMs: number,
  policy: LivenessPolicy = DEFAULT_LIVENESS_POLICY
): LivenessClassification {
  if (evidence.settled) {
    return {
      verdict: 'exited',
      activity: 'settled',
      reason: 'Dispatch reached a settled lifecycle state.',
      terminal: true
    }
  }
  if (evidence.providerExit) {
    const detail =
      evidence.providerExit.signal ??
      (evidence.providerExit.code === null ? 'unknown' : String(evidence.providerExit.code))
    return {
      verdict: 'exited',
      activity: 'crashed',
      reason: `Provider process exited (${detail}) before the Dispatch settled.`,
      terminal: true
    }
  }
  if (evidence.processState === 'exited' || evidence.terminalState === 'closed') {
    return {
      verdict: 'exited',
      activity: 'crashed',
      reason: 'Execution host reports the worker process or terminal is gone.',
      terminal: true
    }
  }
  if (evidence.approvedBlockingWaitUntil) {
    const until = Date.parse(evidence.approvedBlockingWaitUntil)
    if (!Number.isFinite(until) || until > nowMs) {
      return {
        verdict: 'live',
        activity: 'blocked_on_approved_wait',
        reason: 'Worker is inside an Orca-approved blocking wait.',
        terminal: false
      }
    }
  }
  if (evidence.activeToolCall) {
    return {
      verdict: 'live',
      activity: 'working',
      reason: 'Worker has an active tool call.',
      terminal: false
    }
  }
  if (evidence.processState === 'unknown') {
    // Why not `stalled`: an unreachable execution host proves nothing about the
    // worker, and calling that a stall would strand a healthy remote Dispatch.
    return {
      verdict: 'unverifiable',
      activity: 'working',
      reason: 'Execution host is unreachable; liveness cannot be established.',
      terminal: false
    }
  }
  const lastActivityMs = evidence.lastActivityAt ? Date.parse(evidence.lastActivityAt) : Number.NaN
  if (!Number.isFinite(lastActivityMs)) {
    return {
      verdict: 'unverifiable',
      activity: 'working',
      reason: 'No observed activity timestamp for this Dispatch yet.',
      terminal: false
    }
  }
  if (nowMs - lastActivityMs >= policy.stallAfterMs) {
    return {
      verdict: 'live',
      activity: 'stalled',
      reason: `No worker activity for ${Math.floor((nowMs - lastActivityMs) / 1000)}s with no active tool call or approved wait.`,
      terminal: false
    }
  }
  return {
    verdict: 'live',
    activity: 'working',
    reason: 'Worker produced output within the stall window.',
    terminal: false
  }
}

export type LivenessSweepInput = {
  dispatchId: string
  evidence: LivenessEvidence
  epoch?: string | null
}

export type LivenessWake = {
  dispatchId: string
  reason: Extract<CoordinatorWakeReason, 'stalled' | 'crashed'>
  detail: string
}

export type LivenessSweepResult = {
  markers: LivenessMarkerRow[]
  wakes: LivenessWake[]
}

function isoAt(ms: number): string {
  return new Date(ms).toISOString()
}

/** Reads the previous marker, writes the new one, and returns the wakes the
 *  runtime should publish. Emits a wake only on the transition into a stalled
 *  or crashed state, so a repeated sweep is idempotent. */
export function sweepDispatchLiveness(
  store: ControlPlaneStore,
  inputs: readonly LivenessSweepInput[],
  nowMs: number,
  policy: LivenessPolicy = DEFAULT_LIVENESS_POLICY
): LivenessSweepResult {
  const markers: LivenessMarkerRow[] = []
  const wakes: LivenessWake[] = []
  for (const input of inputs) {
    const previous = store.getLivenessMarker(input.dispatchId)
    if (previous?.terminal === 1) {
      markers.push(previous)
      continue
    }
    const classification = classifyDispatchLiveness(input.evidence, nowMs, policy)
    const wakeReason =
      classification.activity === 'stalled'
        ? 'stalled'
        : classification.activity === 'crashed'
          ? 'crashed'
          : undefined
    const alreadyWoke = wakeReason !== undefined && previous?.woke_for === wakeReason
    const marker: LivenessMarkerRow = {
      dispatch_id: input.dispatchId,
      verdict: classification.verdict,
      activity: classification.activity,
      reason: classification.reason,
      observed_at: isoAt(nowMs),
      expires_at: isoAt(nowMs + policy.markerTtlMs),
      epoch: input.epoch ?? null,
      woke_for: wakeReason ?? null,
      terminal: classification.terminal ? 1 : 0
    }
    store.putLivenessMarker(marker)
    markers.push(marker)
    if (wakeReason && !alreadyWoke) {
      wakes.push({
        dispatchId: input.dispatchId,
        reason: wakeReason,
        detail: classification.reason
      })
    }
  }
  return { markers, wakes }
}

/** A marker past its expiry proves nothing; report it as unverifiable rather
 *  than replaying an old `live`.
 *
 *  `settled` is the Dispatch's own lifecycle verdict, which outranks any marker:
 *  a Dispatch that died between two sweeps keeps its last non-terminal marker
 *  until the TTL, and reporting that as `live` is the false `live` this module
 *  exists to prevent. Callers that hold the Dispatch row must pass it. */
export function readLivenessMarker(
  store: ControlPlaneStore,
  dispatchId: string,
  nowMs: number,
  settled?: boolean
): { verdict: LivenessVerdict; activity: LivenessActivity; reason: string; expired: boolean } {
  if (settled) {
    return {
      verdict: 'exited',
      activity: 'settled',
      reason: 'Dispatch reached a settled lifecycle state.',
      expired: false
    }
  }
  const marker = store.getLivenessMarker(dispatchId)
  if (!marker) {
    return {
      verdict: 'unverifiable',
      activity: 'working',
      reason: 'No liveness marker has been written for this Dispatch.',
      expired: false
    }
  }
  const expiresMs = Date.parse(marker.expires_at)
  const expired = marker.terminal === 0 && Number.isFinite(expiresMs) && expiresMs <= nowMs
  return {
    verdict: expired ? 'unverifiable' : marker.verdict,
    activity: marker.activity,
    reason: expired ? `Liveness marker expired at ${marker.expires_at}.` : marker.reason,
    expired
  }
}
