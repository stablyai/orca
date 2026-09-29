import { describe, expect, it, vi } from 'vitest'

vi.mock('./mobile-e2ee-v2-client-session', () => ({
  MobileE2EEV2ClientSession: { create: () => ({}) }
}))

vi.mock('./mobile-e2ee-v2-physical-channel', () => ({
  MobileE2EEAuthenticationError: class extends Error {},
  MobileE2EEV2PhysicalChannel: class {}
}))

import { MOBILE_RELAY_CLOSE_CODE } from '../../../src/shared/mobile-relay-close-codes'
import { RelayOuterError } from './mobile-relay-e2ee-link'
import { RelayHostReachabilityLatch } from './relay-host-reachability-latch'

const closed = (code: number) => new RelayOuterError(code)
const OFFLINE = MOBILE_RELAY_CLOSE_CODE.HOST_OFFLINE
const REFUSED = MOBILE_RELAY_CLOSE_CODE.BAD_OUTER_CREDENTIAL

describe('RelayHostReachabilityLatch', () => {
  it('needs two consecutive identical failures before it reports a verdict', () => {
    const latch = new RelayHostReachabilityLatch()
    const reporter = vi.fn()
    latch.reportTo(reporter)
    expect(reporter).toHaveBeenLastCalledWith('connecting')

    latch.record(closed(OFFLINE))
    expect(latch.current()).toBe('connecting')

    latch.record(closed(OFFLINE))
    expect(latch.current()).toBe('host-offline')
    expect(reporter).toHaveBeenLastCalledWith('host-offline')
    expect(reporter).toHaveBeenCalledTimes(2)
  })

  it('does not report on alternating failures', () => {
    const latch = new RelayHostReachabilityLatch()
    latch.record(closed(OFFLINE))
    latch.record(closed(1006))
    latch.record(closed(OFFLINE))
    expect(latch.current()).toBe('connecting')
  })

  it('replaces a reported verdict once a different one repeats', () => {
    const latch = new RelayHostReachabilityLatch()
    latch.record(closed(OFFLINE))
    latch.record(closed(OFFLINE))
    latch.record(closed(REFUSED))
    expect(latch.current()).toBe('host-offline')
    latch.record(closed(REFUSED))
    expect(latch.current()).toBe('credential-refused')
  })

  // A 4408 between two 4404s is not evidence the desktop came back.
  it('keeps the reported verdict across an unmapped failure but restarts the streak', () => {
    const latch = new RelayHostReachabilityLatch()
    latch.record(closed(OFFLINE))
    latch.record(closed(OFFLINE))
    latch.record(closed(MOBILE_RELAY_CLOSE_CODE.DRAINING))
    expect(latch.current()).toBe('host-offline')
    latch.record(closed(1006))
    expect(latch.current()).toBe('host-offline')
    latch.record(closed(1006))
    expect(latch.current()).toBe('unreachable')
  })

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

  it('clears only on an explicit connection, and a cleared latch starts over', () => {
    const latch = new RelayHostReachabilityLatch()
    const reporter = vi.fn()
    latch.reportTo(reporter)
    latch.record(closed(1006))
    latch.record(closed(1006))
    latch.clear()
    expect(latch.current()).toBe('connecting')
    expect(reporter.mock.calls.map(([value]) => value)).toEqual([
      'connecting',
      'unreachable',
      'connecting'
    ])

    latch.record(closed(1006))
    expect(latch.current()).toBe('connecting')
  })

  it('clears an asserted verdict too', () => {
    const latch = new RelayHostReachabilityLatch()
    latch.assert('signed-out')
    latch.clear()
    expect(latch.current()).toBe('connecting')
  })
})
