import type { BrowserScreencastFrame } from './browser-screencast-protocol'
import type { ConnectionLogSink, ConnectionState, RpcResponse } from './types'

export type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

export type ConnectWaiter = {
  resolve: () => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

export type SendRequestOptions = {
  timeoutMs?: number
  budgetSpansConnect?: boolean
  failWhenDisconnected?: boolean
}

export type SubscribeOptions = {
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
}

export type StreamingListener = (result: unknown) => void

export type StreamRequest = {
  method: string
  params: unknown
  listener: StreamingListener
  onBinaryFrame?: (frame: BrowserScreencastFrame) => void
  subscriptionId?: string
  cancelled?: boolean
  sent?: boolean
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
  onStateChange: (listener: (state: ConnectionState) => void) => () => void
  notifyForeground: () => void
  close: () => void
}

export type ConnectOptions = {
  onStateChange?: (state: ConnectionState) => void
  onLog?: ConnectionLogSink
  endpoints?: readonly string[]
  lastGoodEndpoint?: string | null
  connectTimeoutMs?: number
  onDialSuccess?: (endpoint: string) => void
  autoReconnect?: boolean
}
