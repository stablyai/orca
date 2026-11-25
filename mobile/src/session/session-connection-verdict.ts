import {
  classifyConnection,
  isConnectionDialing,
  isConnectionOutage,
  verdictDisplayLabel,
  type ConnectionVerdict
} from '../transport/connection/connection-health'
import type { ConnectionState } from '../transport/connection/connection-state'
import { MOBILE_SESSION_STATUS_LABELS } from '../transport/connection/mobile-session-connection-copy'
import type { MobileConnectionPath } from '../transport/connection/stable-logical-rpc-client'
import type { RelayHostReachability } from '../transport/relay/relay-host-reachability'

export type SessionConnectionVerdictInputs = {
  state: ConnectionState
  reconnectAttempts: number
  lastConnectedAt: number | null
  endpoint: string | null
  hostName: string | null
  // The host screen's relay inputs, so the session header gives the same verdict for the same host.
  pendingPath: MobileConnectionPath | null
  pairingRejected: boolean
  relayHostReachability: RelayHostReachability
  nowMs?: number
}

// The retry count includes Relay failures, so without relay evidence a Tailscale-pinned host
// would read "check Tailscale" while Relay is being dialed or has named the real cause.
export function sessionConnectionVerdict(
  inputs: SessionConnectionVerdictInputs
): ConnectionVerdict {
  const { hostName, ...rest } = inputs
  return classifyConnection({ ...rest, hostName: hostName ?? undefined })
}

/** Verdicts the header shows at once, as the host header does: an outage or a refused pairing. */
export function isSessionErrorVerdict(verdict: ConnectionVerdict): boolean {
  return isConnectionOutage(verdict) || verdict.kind === 'auth-failed'
}

/** The header's status line, or null while it shows the connected place label instead. */
export type SessionStatusLine = { label: string; withRetrySuffix: boolean } | null

export function sessionStatusLine(args: {
  verdict: ConnectionVerdict
  /** The calmed state: a short self-healing drop still reads connected. */
  presentedConnState: ConnectionState
  pendingPath: MobileConnectionPath | null
  relayHostReachability: RelayHostReachability
  retryShown: boolean
}): SessionStatusLine {
  const { verdict } = args
  // Why: errors skip the calm window, like the host header; a short drop never produces one.
  if (isSessionErrorVerdict(verdict)) {
    return {
      label: verdictDisplayLabel(verdict),
      // Retrying cannot repair a refused pairing or credential; their copy asks for a re-pair.
      withRetrySuffix:
        args.retryShown &&
        isConnectionOutage(verdict) &&
        args.relayHostReachability !== 'credential-refused'
    }
  }
  if (args.presentedConnState === 'connected') {
    return null
  }
  if (args.pendingPath === 'relay' && isConnectionDialing(verdict)) {
    return { label: verdict.label, withRetrySuffix: false }
  }
  return { label: MOBILE_SESSION_STATUS_LABELS[args.presentedConnState], withRetrySuffix: false }
}

/** The header dot: the calmed state with no verdict during a hidden drop, else the verdict's severity. */
export function sessionStatusDot(args: {
  verdict: ConnectionVerdict
  connState: ConnectionState
  presentedConnState: ConnectionState
}): { state: ConnectionState; verdict?: ConnectionVerdict } {
  const calmed = args.presentedConnState !== args.connState && !isSessionErrorVerdict(args.verdict)
  return calmed
    ? { state: args.presentedConnState }
    : { state: args.connState, verdict: args.verdict }
}
