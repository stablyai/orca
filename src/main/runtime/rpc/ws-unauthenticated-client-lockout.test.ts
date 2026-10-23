import { describe, expect, it, vi } from 'vitest'
import { lockoutSource, UnauthenticatedClientLockout } from './ws-unauthenticated-client-lockout'

function lockoutAt(clock: { now: number }) {
  return new UnauthenticatedClientLockout({
    maxFailures: 3,
    windowMs: 1_000,
    blockMs: 5_000,
    now: () => clock.now
  })
}

describe('UnauthenticatedClientLockout', () => {
  it('blocks a source after too many failures inside the window, then releases it', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const clock = { now: 0 }
    const lockout = lockoutAt(clock)
    lockout.recordFailure('198.51.100.1')
    lockout.recordFailure('198.51.100.1')
    expect(lockout.isBlocked('198.51.100.1')).toBe(false)
    lockout.recordFailure('198.51.100.1')
    expect(lockout.isBlocked('198.51.100.1')).toBe(true)
    expect(lockout.isBlocked('198.51.100.2')).toBe(false)
    clock.now = 5_000
    expect(lockout.isBlocked('198.51.100.1')).toBe(false)
  })

  it('forgets failures older than the window', () => {
    const clock = { now: 0 }
    const lockout = lockoutAt(clock)
    lockout.recordFailure('198.51.100.1')
    lockout.recordFailure('198.51.100.1')
    clock.now = 1_500
    lockout.recordFailure('198.51.100.1')
    expect(lockout.isBlocked('198.51.100.1')).toBe(false)
  })

  it('never blocks loopback', () => {
    const lockout = lockoutAt({ now: 0 })
    for (let i = 0; i < 10; i += 1) {
      lockout.recordFailure('127.0.0.1')
    }
    expect(lockout.isBlocked('127.0.0.1')).toBe(false)
  })

  it('counts every address of an IPv6 /64 as one source', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const lockout = lockoutAt({ now: 0 })
    lockout.recordFailure('2001:db8:1:2::a')
    lockout.recordFailure('2001:db8:1:2:ffff::b')
    lockout.recordFailure('2001:0db8:0001:0002:1:2:3:4')
    expect(lockout.isBlocked('2001:db8:1:2::99')).toBe(true)
    expect(lockout.isBlocked('2001:db8:1:3::1')).toBe(false)
  })
})

describe('lockoutSource', () => {
  it('keeps IPv4 addresses and reduces IPv6 to its /64', () => {
    expect(lockoutSource('203.0.113.9')).toBe('203.0.113.9')
    expect(lockoutSource('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(lockoutSource('::1')).toBe('0:0:0:0::/64')
  })
})
