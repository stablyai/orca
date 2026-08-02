import { track } from '../telemetry/client'
import type { EventProps } from '../../shared/telemetry-events'
import type { DaemonAuditObservation } from './daemon-audit-classifier'

// Why: a steady daemon repeats a byte-identical observation on every listProcesses call, so
// repeats are re-sent only as an occasional heartbeat — the shared per-session telemetry
// ceiling is 1,000 events for the whole app and audit data must not crowd it out.
const REPEATED_OBSERVATION_INTERVAL_MS = 5 * 60_000

export function trackDaemonAuditEligibility(observation: DaemonAuditObservation): void {
  try {
    track('daemon_audit_eligibility', auditEligibilityProperties(observation))
  } catch {
    // Audit telemetry cannot affect daemon availability.
  }
}

export function createDaemonAuditEligibilityTracker(
  // Why: the window must be measured on a monotonic clock — a backward wall-clock jump (NTP
  // correction, VM resume) would otherwise park the next heartbeat in the future.
  monotonicNowMs: () => number = () => performance.now()
): (observation: DaemonAuditObservation) => void {
  let lastProperties: string | null = null
  let lastTrackedAtMs = 0
  return (observation) => {
    // Why: the rate-limit bookkeeping runs inside the daemon's inventory path, so it is guarded
    // together with the emit — audit telemetry cannot affect daemon availability.
    try {
      const properties = JSON.stringify(auditEligibilityProperties(observation))
      const observedAtMs = monotonicNowMs()
      const elapsedMs = observedAtMs - lastTrackedAtMs
      if (
        properties === lastProperties &&
        elapsedMs >= 0 &&
        elapsedMs < REPEATED_OBSERVATION_INTERVAL_MS
      ) {
        return
      }
      lastProperties = properties
      lastTrackedAtMs = observedAtMs
      trackDaemonAuditEligibility(observation)
    } catch {
      // Audit telemetry cannot affect daemon availability.
    }
  }
}

function auditEligibilityProperties(
  observation: DaemonAuditObservation
): EventProps<'daemon_audit_eligibility'> {
  return {
    state: observation.state,
    reason: observation.reason,
    trigger: observation.trigger,
    evidence_sources: [...observation.evidenceSources],
    protocol_generation: observation.context.protocolGeneration,
    provider: observation.context.provider,
    endpoint_kind: observation.context.endpointKind,
    profile_scope: observation.context.profileScope ? 'configured' : 'unspecified',
    exact_incarnation: exactIncarnationKind(observation),
    reachability: observation.reachability,
    inventory_authority: observation.inventoryAuthority,
    process_liveness: observation.processLiveness,
    process_reason: observation.processReason,
    endpoint_state: observation.endpointState
  }
}

function exactIncarnationKind(
  observation: DaemonAuditObservation
): 'endpoint-identity' | 'endpoint-identity-linux-ticks' | 'unavailable' {
  if (!observation.exactIncarnation) {
    return 'unavailable'
  }
  return observation.exactIncarnation.linuxStartTicks && observation.exactIncarnation.bootId
    ? 'endpoint-identity-linux-ticks'
    : 'endpoint-identity'
}
