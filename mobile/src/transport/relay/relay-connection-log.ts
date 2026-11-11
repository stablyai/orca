import type { ConnectionLogEntry } from '../../diagnostics/connection/connection-log-types'
import type { LivenessTimeoutEvidence } from '../rpc/rpc-session-liveness-watchdog'

export function buildRelayLivenessTimeoutLog(
  logSessionId: string,
  sequence: number,
  evidence: LivenessTimeoutEvidence
): ConnectionLogEntry {
  return {
    id: `relay-liveness-${logSessionId}-${sequence}`,
    ts: Date.now(),
    level: 'error',
    code: 'liveness-timeout',
    path: 'relay',
    message: 'Relay health check failed',
    detail: `${evidence.reason}; ${evidence.missedProbes}/${evidence.missedProbeLimit} probes missed; last authenticated activity ${evidence.lastInboundAgeMs}ms ago`
  }
}
