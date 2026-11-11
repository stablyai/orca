import type { AuthenticatedMobileSocket } from '../mobile-socket-wiring'

/** Who connected, without credentials: a phone's clientId can be its bearer token, so it is never logged. */
export function describeClientConnection(
  socket: Pick<AuthenticatedMobileSocket, 'connectionId' | 'device' | 'transport'>
): Record<string, string> {
  return {
    deviceId: socket.device.deviceId,
    scope: socket.device.scope,
    transport: socket.transport.transport,
    connectionId: socket.connectionId
  }
}

// One line per authenticated socket, so a host's log shows which client was attached when (#40328).
export function logClientConnection(
  event: 'connected' | 'disconnected',
  socket: Pick<AuthenticatedMobileSocket, 'connectionId' | 'device' | 'transport'>
): void {
  console.info(`[runtime-rpc] client ${event}`, describeClientConnection(socket))
}
