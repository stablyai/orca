import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'

// Pure on purpose: the diagnostics analysis shares this mapping and runs without
// React Native, so nothing here may import the relay link or its errors.

// What the relay says about the desktop, for the host row. Closed: every other
// failure is 'connecting', because the relay is still retrying it and no copy
// would be truer than "Connecting via Relay…".
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
