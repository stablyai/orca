// Keep this mapping independent of React Native so diagnostics can import it.
import { describe, expect, it } from 'vitest'
import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'
import {
  relayHostReachabilityForCloseCode,
  type RelayHostReachabilityFromCloseCode
} from './relay-host-reachability'

describe('relayHostReachabilityForCloseCode', () => {
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
