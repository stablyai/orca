import { useEffect } from 'react'
import type { HostStatusGates } from '../transport/host-status-gates'
import type { HostStatusReply } from '../transport/host-status-reply-schema'
import { provenHostStatus } from '../transport/proven-host-status'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { readMobileWebShellReachability } from './mobile-web-shell-reachability'
import { isEarlyConnectRetry } from '../transport/connection-health'
import type { MobileWebShellGates } from './mobile-web-shell-session-contract'

/** Feeds the host route's gates to the shell session, and returns the status they proved for the page's init. */
export function useMobileWebShellGates(args: {
  gates: HostStatusGates
  connState: ConnectionState
  client: RpcClient | null
  // A new host or pathname rebuilds the session, which must hear the gates again.
  rearmKey: string
  onGates: (gates: MobileWebShellGates) => void
}): HostStatusReply | null {
  const { gates, connState, client, rearmKey, onGates } = args
  const { statusPending, statusReadable, hostCapabilities, hostProtocolWindow } = gates
  const reachability = readMobileWebShellReachability(connState, client)
  const retrying =
    client !== null && isEarlyConnectRetry(connState, () => client.getReconnectAttempt())
  useEffect(() => {
    onGates({
      statusPending,
      statusReadable,
      reachability,
      retrying,
      hostCapabilities,
      hostStatus: hostProtocolWindow
    })
    // Host and pathname rebuild the session; re-arm even on an unchanged verdict or the fresh session would remain checking.
  }, [
    onGates,
    hostCapabilities,
    rearmKey,
    hostProtocolWindow,
    reachability,
    retrying,
    statusPending,
    statusReadable
  ])
  // Proven gates outlive a drop; the page must not be seeded from a connection that is gone.
  return connState === 'connected' && client !== null ? provenHostStatus(gates) : null
}
