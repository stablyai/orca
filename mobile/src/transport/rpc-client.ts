import type { BrowserScreencastFrame } from './browser-screencast-protocol'
import { DirectRpcClient } from './direct-rpc-client'
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

type SubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
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
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
  /**
   * Must settle every pending `sendRequest` promise before returning.
   *
   * `StableLogicalRpcClient.migrateTo` no longer rejects pendings itself — the physical
   * sender is the only layer that knows whether a request reached the wire, so
   * `previous.close()` is the sole settlement path for the retiring generation. An
   * implementation that leaves a request pending strands its caller for good.
   *
   * Requests that did reach the wire must reject with a delivery-unknown error
   * (`markRpcDeliveryUnknown`), since the host may already have executed them.
   * `rpc-client-close-settlement.test.ts` pins this for every implementation.
   */
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
