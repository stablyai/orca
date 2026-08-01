// Why: the transport interface decouples the RPC server from a specific
// transport mechanism (Unix socket, WebSocket, named pipe). Each transport
// owns its own connection lifecycle — the RPC server just binds message
// handling to whatever transports are registered. Individual transports
// override `onMessage` with their own richer signatures (e.g. Unix adds a
// `RpcMessageContext` with an abort signal; WebSocket adds the `ws` handle
// for auth association). Consumers hold a concrete transport type, not
// `RpcTransport`, when they need those extensions.

// Why: per-message hook bag owned by the Unix transport. `signal` aborts
// when the underlying connection terminates so long-poll handlers can bail
// out. `startKeepalive` is opt-in per request; an optional duration bounds
// slow non-abortable dispatches. See design doc §3.1.
export type RpcMessageContext = {
  signal: AbortSignal
  startKeepalive: (maxDurationMs?: number) => void
}

export type RpcTransport = {
  start(): Promise<void>
  stop(): Promise<void>
}
