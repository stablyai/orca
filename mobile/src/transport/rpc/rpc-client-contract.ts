import type { RpcStreamSubscribeOptions } from './rpc-client-stream-request'
import type { RelayHostReachability } from '../relay/relay-host-reachability'
import type { MobileConnectionPath } from '../connection/stable-logical-rpc-client'
import type { ConnectionState, ForegroundNudgeReason } from '../connection/connection-state'
import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'

type StreamingListener = (result: unknown) => void

// Holding a client also exposes the raw port, so the boundary inventory must cover client holders.
export type RpcClient = UnvalidatedRpcRequestPort & {
  requestRoute?: (params: unknown) => { client: RpcClient; intermediary?: RpcClient }
  subscribe: (
    method: string,
    params: unknown,
    onData: StreamingListener,
    options?: RpcStreamSubscribeOptions
  ) => () => void
  updateTerminalSubscriptionViewport: (
    terminal: string,
    viewport: { cols: number; rows: number }
  ) => void
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  getLastConnectedAt: () => number | null
  getLastInboundAt?: () => number | null
  // Optional logical authority epoch for scoping cached work across migrateTo; physical clients need no counter.
  getGeneration?: () => number
  // Logical clients name the path they use and the one they are dialing; physical clients have one path.
  getActivePath?: () => MobileConnectionPath
  getPendingPath?: () => MobileConnectionPath | null
  getRelayHostReachability?: () => RelayHostReachability
  onConnectionPathChange?: (listener: () => void) => () => void
  // A page's client: the status its shell's gate already proved, so the page need not ask again.
  getShellHostStatus?: () => unknown
  /** False when this transport would refuse an `envelope`; absent means it carries one. */
  carriesRpcEnvelope?: () => boolean
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
  // A caller that stopped hearing back asks for one decisive probe, so a silently dead socket ends in seconds.
  probeLivenessNow?: () => void
  // Settle every pending request before returning; only the physical sender knows which reached the wire.
  // Reject written requests with markRpcDeliveryUnknown: the host may already have executed them.
  close: () => void
}
