import type { PtyFencedTerminationRequest } from '../../../shared/terminal/pty/lifecycle/pty-fenced-termination'
import type { KillRequest } from './daemon-rpc-contract'
import {
  FENCED_TERMINATION_PROTOCOL_VERSION,
  IDLE_FENCED_TERMINATION_PROTOCOL_VERSION
} from './daemon-protocol-version'

export function supportsDaemonFencedTermination(protocol: number, requireIdle?: true): boolean {
  return (
    protocol >=
    (requireIdle ? IDLE_FENCED_TERMINATION_PROTOCOL_VERSION : FENCED_TERMINATION_PROTOCOL_VERSION)
  )
}

export function daemonFencedKillPayload(
  request: PtyFencedTerminationRequest,
  protocol: number
): KillRequest['payload'] | undefined {
  if (!supportsDaemonFencedTermination(protocol, request.requireIdle)) {
    return undefined
  }
  const {
    id: sessionId,
    requireNoAgentOwner,
    requireUnattached,
    requireIdle,
    idleCheckSinceMs,
    expectedIncarnationId
  } = request
  return {
    sessionId,
    immediate: true,
    requireNoAgentOwner,
    requireUnattached,
    expectedIncarnationId,
    ...(requireIdle ? { requireIdle, idleCheckSinceMs } : {})
  }
}
