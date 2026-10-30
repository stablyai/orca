import { describe, expect, it } from 'vitest'
import { RateLimiter } from './rate-limiter.js'

describe('rate limiter', () => {
  it('keeps unused allowance when the clock steps back', () => {
    let now = 120_000
    const limiter = new RateLimiter(2, () => now)
    expect(limiter.allow('a')).toBe(true)
    now = 60_000
    expect(limiter.allow('a')).toBe(true)
    expect(limiter.allow('a')).toBe(false)
  })
})
