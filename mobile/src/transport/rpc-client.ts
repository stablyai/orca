import { DirectRpcClient } from './direct-rpc-client'
import type { RpcStreamSubscribeOptions } from './rpc-client-stream-registry'
import type { TerminalStreamFrame } from './terminal-stream-protocol'
import type {
  ConnectionLogSink,
  ConnectionState,
  ForegroundNudgeReason,
  RpcResponse
} from './types'

export type SendRequestOptions = {
  timeoutMs?: number
  /** Include the connect wait in the caller's timeout budget. */
  budgetSpansConnect?: boolean
  /** Reject instead of replaying the request after reconnect. */
  failWhenDisconnected?: boolean
}

type StreamingListener = (result: unknown) => void

export type RpcClient = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ) => Promise<RpcResponse>
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
  // Why: the hosted bridge multiplexes terminal bytes over one binary channel.
  sendTerminalBinaryFrame: (frame: TerminalStreamFrame) => boolean
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  getLastConnectedAt: () => number | null
  getLastInboundAt?: () => number | null
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
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
