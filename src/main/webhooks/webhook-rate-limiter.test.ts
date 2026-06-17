import { describe, expect, it } from 'vitest'
import { WebhookRateLimiter } from './webhook-rate-limiter'

describe('WebhookRateLimiter', () => {
  it('allows up to maxRequests within the window, then blocks', () => {
    const limiter = new WebhookRateLimiter({ windowMs: 1000, maxRequests: 3 })
    expect(limiter.tryAcquire('a', 0)).toBe(true)
    expect(limiter.tryAcquire('a', 100)).toBe(true)
    expect(limiter.tryAcquire('a', 200)).toBe(true)
    expect(limiter.tryAcquire('a', 300)).toBe(false)
  })

  it('tracks keys independently', () => {
    const limiter = new WebhookRateLimiter({ windowMs: 1000, maxRequests: 1 })
    expect(limiter.tryAcquire('a', 0)).toBe(true)
    expect(limiter.tryAcquire('b', 0)).toBe(true)
    expect(limiter.tryAcquire('a', 0)).toBe(false)
  })

  it('frees capacity once the window slides past old hits', () => {
    const limiter = new WebhookRateLimiter({ windowMs: 1000, maxRequests: 1 })
    expect(limiter.tryAcquire('a', 0)).toBe(true)
    expect(limiter.tryAcquire('a', 500)).toBe(false)
    expect(limiter.tryAcquire('a', 1001)).toBe(true)
  })

  it('prunes idle keys', () => {
    const limiter = new WebhookRateLimiter({ windowMs: 1000, maxRequests: 5 })
    limiter.tryAcquire('a', 0)
    limiter.prune(2000)
    // After pruning a fully-expired key, capacity is fresh.
    expect(limiter.tryAcquire('a', 2001)).toBe(true)
  })
})
