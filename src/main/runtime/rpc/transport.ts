import type { RuntimeRpcProgress } from '../../../shared/runtime-rpc-envelope'

// Transports own connection lifecycle; RPC binds messages across Unix sockets, WebSockets and named pipes.
// Rich message context (abort signals, authenticated sockets) requires each concrete transport type.

// Unix per-request hooks: connection close aborts long polls; only opted-in long polls pay for keepalive timers (design §3.1).
export type RpcMessageContext = {
  signal: AbortSignal
  startKeepalive: () => void
  /** Long polls only: piggybacks a progress note on a keepalive frame; older clients ignore it. */
  reportProgress?: (progress: RuntimeRpcProgress) => void
}

export type RpcTransport = {
  start(): Promise<void>
  stop(): Promise<void>
}
