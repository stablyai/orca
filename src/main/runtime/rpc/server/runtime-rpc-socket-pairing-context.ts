import type { PairingRpcContext } from '../core'
import type { AuthenticatedMobileSocket } from '../mobile/mobile-socket-wiring'
import type { MobileRelayPairingProvider } from './runtime-rpc-pairing-types'

/** Relay pairing calls answer only for the socket that asked, so a phone can confirm only its own credential. */
export function socketPairingRpcContext(
  provider: MobileRelayPairingProvider | null,
  socket: AuthenticatedMobileSocket | undefined
): PairingRpcContext | undefined {
  if (!provider || !socket) {
    return undefined
  }
  const context = () => ({
    deviceId: socket.device.deviceId,
    connectionId: socket.connectionId,
    transport: socket.transport
  })
  return {
    getEndpoints: (params) => provider.getEndpoints(context(), params),
    provisionRelay: (params) => provider.provisionRelay(context(), params)
  }
}
