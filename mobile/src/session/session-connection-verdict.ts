import {
  classifyConnection,
  type ConnectionVerdict
} from '../transport/connection/connection-health'
import type { ConnectionState } from '../transport/connection/connection-state'
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
