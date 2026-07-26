import { describe, expect, it } from 'vitest'
import {
  mobileTerminalRetryDelay,
  recordMobileTerminalActivationFailure
} from './mobile-terminal-retry-delay'

describe('mobileTerminalRetryDelay', () => {
  it('backs off repeated failures and caps the delay', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(mobileTerminalRetryDelay)).toEqual([
      500, 1000, 2000, 4000, 8000, 16_000, 30_000, 30_000
    ])
  })

  it('records activation failures without clearing a newer in-flight key', () => {
    const failuresRef = { current: null as { key: string; count: number } | null }
    const attemptRef = { current: 'first' as string | null }

    expect(recordMobileTerminalActivationFailure(failuresRef, attemptRef, 'first')).toBe(500)
    attemptRef.current = 'second'
    expect(recordMobileTerminalActivationFailure(failuresRef, attemptRef, 'first')).toBe(1000)
    expect(attemptRef.current).toBe('second')
  })
})
