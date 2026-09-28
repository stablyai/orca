// No transport import on purpose: the diagnostics analysis shares this mapping
// and must keep resolving it without React Native.
import { describe, expect, it } from 'vitest'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'
import {
  relayHostReachabilityForCloseCode,
  type RelayHostReachabilityFromCloseCode
} from './relay-host-reachability'

describe('relayHostReachabilityForCloseCode', () => {
  // The closed mapping: every code the cell can send, plus the transport close.
  it.each<[number, RelayHostReachabilityFromCloseCode]>([
    [MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE, 'host-offline'],
    [MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL, 'credential-refused'],
    [1006, 'unreachable'],
    [MOBILE_RELAY_CLOSE_CODE.PEER_DROPPED, 'connecting'],
    [MOBILE_RELAY_CLOSE_CODE.WRONG_CELL, 'connecting'],
    [MOBILE_RELAY_CLOSE_CODE.LIMIT_EXCEEDED, 'connecting'],
    [MOBILE_RELAY_CLOSE_CODE.DRAINING, 'connecting'],
    [1000, 'connecting']
  ])('maps close %d to %s', (code, expected) => {
    expect(relayHostReachabilityForCloseCode(code)).toBe(expected)
  })
})
