import { createHash } from 'node:crypto'
import { track } from '../telemetry/client'
import type { EventProps } from '../../shared/telemetry-events'
import type { DaemonAuditObservation } from './daemon-audit-classifier'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

// Rate-limit identical observations so audit heartbeats cannot consume the shared telemetry budget.
const REPEATED_OBSERVATION_INTERVAL_MS = 5 * 60_000
const INCARNATION_CORRELATION_DOMAIN = 'orca:daemon-audit-eligibility:incarnation:v1'
type AuditEligibilityCommonProperties = Omit<
  Extract<EventProps<'daemon_audit_eligibility'>, { exact_incarnation: 'unavailable' }>,
  'exact_incarnation'
>

export function trackDaemonAuditEligibility(observation: DaemonAuditObservation): void {
  try {
    track('daemon_audit_eligibility', auditEligibilityProperties(observation, hashLaunchNonce))
  } catch {
    // Audit telemetry cannot affect daemon availability.
  }
}

export function createDaemonAuditEligibilityTracker(
  // Use monotonic time so clock corrections cannot postpone heartbeats.
  monotonicNowMs: () => number = () => performance.now()
): (observation: DaemonAuditObservation) => void {
  let lastProperties: string | null = null
  let lastTrackedAtMs = 0
  const correlateLaunchNonce = createLaunchNonceCorrelationCache()
  return (observation) => {
    // Guard bookkeeping too: inventory must remain available if telemetry processing fails.
    try {
      const eventProperties = auditEligibilityProperties(observation, correlateLaunchNonce)
      const properties = JSON.stringify(eventProperties)
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
      track('daemon_audit_eligibility', eventProperties)
    } catch {
      // Audit telemetry cannot affect daemon availability.
    }
  }
}

function auditEligibilityProperties(
  observation: DaemonAuditObservation,
  correlateLaunchNonce: (launchNonce: string) => string
): EventProps<'daemon_audit_eligibility'> {
  const generationRole = generationRoleForProtocol(observation.context.protocolGeneration)
  const commonProperties: AuditEligibilityCommonProperties = {
    state: observation.state,
    reason: observation.reason,
    trigger: observation.trigger,
    evidence_sources: [...observation.evidenceSources],
    protocol_generation: observation.context.protocolGeneration,
    generation_role: generationRole,
    provider: observation.context.provider,
    endpoint_kind: observation.context.endpointKind,
    profile_scope: observation.context.profileScope ? 'configured' : 'unspecified',
    reachability: observation.reachability,
    inventory_authority: observation.inventoryAuthority,
    process_liveness: observation.processLiveness,
    process_reason: observation.processReason,
    endpoint_state: observation.endpointState
  }
  if (!observation.exactIncarnation) {
    return { ...commonProperties, exact_incarnation: 'unavailable' }
  }
  return {
    ...commonProperties,
    exact_incarnation: exactIncarnationKind(observation.exactIncarnation),
    exact_incarnation_correlation: correlateLaunchNonce(
      observation.exactIncarnation.identity.launchNonce
    )
  }
}

function generationRoleForProtocol(protocolGeneration: number): 'current' | 'legacy' {
  if (protocolGeneration === PROTOCOL_VERSION) {
    return 'current'
  }
  if (protocolGeneration > 0 && protocolGeneration < PROTOCOL_VERSION) {
    return 'legacy'
  }
  throw new Error('unsupported_daemon_audit_protocol_generation')
}

function exactIncarnationKind(
  exactIncarnation: NonNullable<DaemonAuditObservation['exactIncarnation']>
): 'endpoint-identity' | 'endpoint-identity-linux-ticks' {
  return exactIncarnation.linuxStartTicks && exactIncarnation.bootId
    ? 'endpoint-identity-linux-ticks'
    : 'endpoint-identity'
}

function createLaunchNonceCorrelationCache(): (launchNonce: string) => string {
  let cachedNonce: string | null = null
  let cachedCorrelation = ''
  return (launchNonce) => {
    if (launchNonce !== cachedNonce) {
      cachedNonce = launchNonce
      cachedCorrelation = hashLaunchNonce(launchNonce)
    }
    return cachedCorrelation
  }
}

function hashLaunchNonce(launchNonce: string): string {
  const digest = createHash('sha256')
    .update(INCARNATION_CORRELATION_DOMAIN)
    .update('\0')
    .update(launchNonce)
    .digest('hex')
  return `v1:${digest.slice(0, 32)}`
}
