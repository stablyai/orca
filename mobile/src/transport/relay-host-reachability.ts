import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'

// Keep pure for diagnostics consumers outside React Native.

// Unknown failures remain connecting; only named relay evidence establishes a desktop verdict.
export type RelayHostReachability =
  | 'connecting'
  | 'signed-out' // the cell named the desktop's own Orca Cloud sign-out as the reason
  | 'host-offline' // 4404: the cell answered, the desktop is not attached to it
  | 'credential-refused' // 4401 / director 401: this device's relay credential was refused
  | 'unreachable' // 1006: the phone never reached the cell

// Only the cell's close reason can name a sign-out; a close code never does.
export type RelayHostReachabilityFromCloseCode = Exclude<RelayHostReachability, 'signed-out'>

// Transport close: the socket errored or closed without a cell-issued code.
const TRANSPORT_CLOSE_CODE = 1006

export function relayHostReachabilityForCloseCode(
  code: number
): RelayHostReachabilityFromCloseCode {
  switch (code) {
    case MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE:
      return 'host-offline'
    case MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL:
      return 'credential-refused'
    case TRANSPORT_CLOSE_CODE:
      return 'unreachable'
    default:
      return 'connecting'
  }
}
