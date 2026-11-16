import type { RuntimeRpcProgress } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

// Transports own connection lifecycle; RPC binds messages across Unix sockets, WebSockets and named pipes.
// Rich message context (abort signals, authenticated sockets) requires each concrete transport type.

// Unix per-request hooks: connection close aborts long polls; only opted-in long polls pay for keepalive timers (design §3.1).
export type RpcMessageContext = {
  signal: AbortSignal
  startKeepalive: () => void
  /** Long polls only: rides on a keepalive frame, which older clients read as a plain keepalive. */
  reportProgress?: (progress: RuntimeRpcProgress) => void
}

export type RpcTransport = {
  start(): Promise<void>
  stop(): Promise<void>
}
