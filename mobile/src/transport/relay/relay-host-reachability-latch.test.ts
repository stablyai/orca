import { describe, expect, it, vi } from 'vitest'

vi.mock('../encryption/mobile-e2ee-v2-client-session', () => ({
  MobileE2EEV2ClientSession: { create: () => ({}) }
}))

vi.mock('../encryption/mobile-e2ee-v2-physical-channel', () => ({
  MobileE2EEAuthenticationError: class extends Error {},
  MobileE2EEV2PhysicalChannel: class {}
}))

import { MOBILE_RELAY_CLOSE_CODE } from '../../../../src/shared/remote-runtime/relay/mobile-relay-close-codes'
import { RelayOuterError } from '../encryption/mobile-relay-e2ee-link'
import { RelayHostReachabilityLatch } from './relay-host-reachability-latch'

const closed = (code: number) => new RelayOuterError(code)
const OFFLINE = MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE

describe('RelayHostReachabilityLatch', () => {
  // A 4408 between two 4404s is not evidence the desktop came back.

  it('reports an asserted verdict immediately and pins it against later failures', () => {
    const latch = new RelayHostReachabilityLatch()
    const reporter = vi.fn()
    latch.reportTo(reporter)

    latch.assert('signed-out')
    expect(latch.current()).toBe('signed-out')

    latch.record(closed(OFFLINE))
    latch.record(closed(OFFLINE))
    expect(latch.current()).toBe('signed-out')
    expect(reporter.mock.calls.map(([value]) => value)).toEqual(['connecting', 'signed-out'])
  })
})
