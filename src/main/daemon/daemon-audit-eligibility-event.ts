import { track } from '../telemetry/client'
import type { DaemonAuditObservation } from './daemon-audit-classifier'

export function trackDaemonAuditEligibility(observation: DaemonAuditObservation): void {
  try {
    track('daemon_audit_eligibility', {
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
    })
  } catch {
    // Audit telemetry cannot affect daemon availability.
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
