export const WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES = 1024 * 1024
// Why: one desktop remote-host client can hold many concurrent streams, so keep the cap high enough that stale streams don't starve control RPCs.
export const WEBSOCKET_TRANSPORT_MAX_CONNECTIONS = 128
// Why: bound pre-upgrade descriptor use above the WS cap so raw sockets can't grow without bound.
export const WEBSOCKET_TRANSPORT_MAX_TCP_CONNECTIONS = WEBSOCKET_TRANSPORT_MAX_CONNECTIONS * 2
