import type { BrowserScreencastFrame } from './browser-screencast-protocol'
import { DirectRpcClient } from './direct-rpc-client'
import type { RpcEnvelopeFields } from './rpc-envelope-fields'
import type { ConnectionLogSink, ConnectionState, ForegroundNudgeReason } from './types'
import type { UnvalidatedRpcRequestPort } from './unvalidated-rpc-request-port'

export type { SendRequestOptions } from './unvalidated-rpc-request-port'

type SubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  // Repeat these top-level fields on subscription replay and unsubscribe.
  envelope?: RpcEnvelopeFields
}

type StreamingListener = (result: unknown) => void

// Holding a client also exposes the raw port, so the boundary inventory must cover client holders.
export type RpcClient = UnvalidatedRpcRequestPort & {
  subscribe: (
    method: string,
    params: unknown,
    onData: StreamingListener,
    options?: SubscribeOptions
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

export type ConnectOptions = {
  onStateChange?: (state: ConnectionState) => void
  onLog?: ConnectionLogSink
}

export function connect(
  endpoint: string,
  deviceToken: string,
  serverPublicKeyB64: string,
  optionsOrLegacy?: ConnectOptions | ((state: ConnectionState) => void)
): RpcClient {
  const options: ConnectOptions =
    typeof optionsOrLegacy === 'function'
      ? { onStateChange: optionsOrLegacy }
      : (optionsOrLegacy ?? {})
  return new DirectRpcClient(endpoint, deviceToken, serverPublicKeyB64, options)
}
