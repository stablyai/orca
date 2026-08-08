// Why: a failed attach-only retire leaves an untracked shell on a pre-v31
// daemon. Console alone is not enough for packaged/headless support (#12662).

import { track } from '../telemetry/client'

export function trackAttachOnlyOrphanRisk(props: {
  protocolVersion: number
  killErrorClass: 'transport' | 'timeout' | 'not_found' | 'unknown'
}): void {
  try {
    track('daemon_attach_only_orphan_risk', {
      protocol_version: props.protocolVersion,
      kill_error_class: props.killErrorClass
    })
  } catch {
    // Telemetry must never block attach refusal.
  }
}

export function classifyAttachOnlyKillError(
  error: unknown
): 'transport' | 'timeout' | 'not_found' | 'unknown' {
  const message = error instanceof Error ? error.message : String(error)
  // Why: DaemonClient rejects in-flight RPCs as "Connection lost" / "Disconnected"
  // on socket drop — match those exact surfaces, not free-text "transport".
  if (
    /not connected|connection lost|disconnected|EPIPE|ECONNRESET|ECONNREFUSED|socket closed/i.test(
      message
    )
  ) {
    return 'transport'
  }
  if (/timed? ?out|timeout/i.test(message)) {
    return 'timeout'
  }
  if (/not found|Session not found/i.test(message)) {
    return 'not_found'
  }
  return 'unknown'
}
