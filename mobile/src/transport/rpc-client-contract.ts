import type { BrowserScreencastFrame } from './browser-screencast-protocol'
import type { ConnectionState, ForegroundNudgeReason, RpcResponse } from './types'

export type SendRequestOptions = {
  timeoutMs?: number
  /** Spend `timeoutMs` across connect-wait and the request. */
  budgetSpansConnect?: boolean
  /** Reject immediately when not connected so stale terminal bytes cannot replay. */
  failWhenDisconnected?: boolean
}

export type SubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  /** Rebuild cursor-bearing params after a transport reconnect. */
  paramsForReconnect?: () => unknown
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
  // Wall-clock stamp of the last inbound frame on the current session, or null when the
  // transport can't vouch for one. Optional so older/foreign RpcClient shapes stay valid;
  // callers must treat absent/null as "unknown" and fall back to a safe bound.
  getLastInboundAt?: () => number | null
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
  restartAfterStructuredBackground?: () => void
  confirmStructuredStreamLongevity?: () => void
  close: () => void
}

export type StructuredReconnectSignal = {
  backgroundRestart: boolean
  streamLongevityConfirmed: boolean
}
