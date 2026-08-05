import type { BrowserScreencastFrame } from './browser-screencast-protocol'
import type { RpcApplicationResponsiveness } from './rpc-application-responsiveness'
import type {
  ConnectionLogSink,
  ConnectionState,
  ForegroundNudgeReason,
  RpcResponse
} from './types'

export type SendRequestOptions = {
  timeoutMs?: number
  /** Spend `timeoutMs` across connect-wait and request instead of restarting after connect. */
  budgetSpansConnect?: boolean
  /** Do not grant the normal post-connect acknowledgement floor. */
  strictDeadline?: boolean
  /** Reject immediately instead of replaying a disconnected request after reconnect. */
  failWhenDisconnected?: boolean
  /** Treat a timeout as application-health evidence, not only a request failure. */
  applicationHealthProbe?: boolean
}

export type SubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
}

export type RpcClient = {
  sendRequest: (
    method: string,
    params?: unknown,
    options?: SendRequestOptions
  ) => Promise<RpcResponse>
  subscribe: (
    method: string,
    params: unknown,
    onData: (result: unknown) => void,
    options?: SubscribeOptions
  ) => () => void
  updateTerminalSubscriptionViewport: (
    terminal: string,
    viewport: { cols: number; rows: number }
  ) => void
  getState: () => ConnectionState
  getReconnectAttempt: () => number
  getLastConnectedAt: () => number | null
  getRpcUnresponsiveSince?: () => number | null
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
  close: () => void
}

export type ConnectOptions = {
  onStateChange?: (state: ConnectionState) => void
  onLog?: ConnectionLogSink
  applicationResponsiveness?: RpcApplicationResponsiveness
}
