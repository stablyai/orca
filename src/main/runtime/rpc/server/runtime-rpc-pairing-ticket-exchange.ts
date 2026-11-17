import type {
  ExchangePairingTicketParams,
  ExchangePairingTicketResult
} from '../../../../shared/remote-runtime/pairing/ticket-exchange-contract'
import type { DeviceRegistry } from './pairing/device-registry'
import type { AuthenticatedMobileSocket } from '../mobile/mobile-socket-wiring'

/** Only a socket that signed in with the pairing token itself may propose its replacement. */
export function exchangeSocketPairingTicket(
  registry: DeviceRegistry,
  socket: AuthenticatedMobileSocket,
  params: ExchangePairingTicketParams
): ExchangePairingTicketResult {
  const presentedToken = socket.device.deviceToken
  if (presentedToken === undefined || !registry.resolveAuthenticatedPrincipal(socket.device)) {
    throw new Error('unauthorized')
  }
  registry.exchangePairingTicket(socket.device.deviceId, presentedToken, params.deviceToken)
  return { deviceId: socket.device.deviceId }
}
