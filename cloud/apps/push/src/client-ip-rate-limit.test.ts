import { PUSH_LIMITS } from '@orca-cloud/push-contract'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { ClientIpRateLimiter, clientIpRateLimit } from './client-ip-rate-limit.js'

const CAPACITY = PUSH_LIMITS.unauthenticatedRequestsPerMinutePerIp

function limiterApp(limiter: ClientIpRateLimiter): Hono {
  const app = new Hono()
  app.post('/probe', clientIpRateLimit(limiter), (context) => context.json({ ok: true }))
  return app
}

describe('client ip rate limiter', () => {
  it('admits exactly the per-minute allowance and refuses the next request', () => {
    const limiter = new ClientIpRateLimiter({ now: () => 1_000 })
    for (let index = 0; index < CAPACITY; index++) {
      expect(limiter.allow('203.0.113.7')).toBe(true)
    }
    expect(limiter.allow('203.0.113.7')).toBe(false)
  })

  it('keeps one client ip from spending another one budget', () => {
    const limiter = new ClientIpRateLimiter({ now: () => 1_000 })
    for (let index = 0; index < CAPACITY; index++) limiter.allow('203.0.113.7')
    expect(limiter.allow('203.0.113.7')).toBe(false)
    expect(limiter.allow('198.51.100.9')).toBe(true)
  })

  it('refills over the window rather than resetting on a boundary', () => {
    let clock = 1_000
    const limiter = new ClientIpRateLimiter({ now: () => clock })
    for (let index = 0; index < CAPACITY; index++) limiter.allow('203.0.113.7')
    expect(limiter.allow('203.0.113.7')).toBe(false)

    // Half a window buys back half the allowance, no more.
    clock += 30_000
    for (let index = 0; index < CAPACITY / 2; index++) {
      expect(limiter.allow('203.0.113.7')).toBe(true)
    }
    expect(limiter.allow('203.0.113.7')).toBe(false)
  })

  it('bounds what it remembers when a flood of distinct ips arrives', () => {
    let clock = 1_000
    const limiter = new ClientIpRateLimiter({ now: () => clock, maxTrackedIps: 8 })
    for (let index = 0; index < 200; index++) {
      clock += 1
      limiter.allow(`198.51.100.${index}`)
    }
    expect(limiter.trackedIpCount()).toBeLessThanOrEqual(8)
  })

  it('answers 429 with a rate_limited body once the bucket is empty', async () => {
    const app = limiterApp(new ClientIpRateLimiter({ now: () => 1_000 }))
    const headers = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' }
    for (let index = 0; index < CAPACITY; index++) {
      expect((await app.request('/probe', { method: 'POST', headers })).status).toBe(200)
    }
    const limited = await app.request('/probe', { method: 'POST', headers })
    expect(limited.status).toBe(429)
    expect(await limited.json()).toEqual({ error: 'rate_limited' })
  })

  it('buckets on the first forwarded hop, not the proxy chain behind it', async () => {
    const app = limiterApp(new ClientIpRateLimiter({ now: () => 1_000 }))
    for (let index = 0; index < CAPACITY; index++) {
      await app.request('/probe', {
        method: 'POST',
        headers: { 'x-forwarded-for': `203.0.113.7, 10.0.0.${index}` }
      })
    }
    const sameClient = await app.request('/probe', {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7, 10.9.9.9' }
    })
    expect(sameClient.status).toBe(429)
    const otherClient = await app.request('/probe', {
      method: 'POST',
      headers: { 'x-forwarded-for': '198.51.100.9, 10.0.0.1' }
    })
    expect(otherClient.status).toBe(200)
  })

  it('falls back to x-real-ip and then to a single shared bucket', async () => {
    const app = limiterApp(new ClientIpRateLimiter({ now: () => 1_000, capacity: 1 }))
    expect(
      (await app.request('/probe', { method: 'POST', headers: { 'x-real-ip': '203.0.113.7' } }))
        .status
    ).toBe(200)
    expect(
      (await app.request('/probe', { method: 'POST', headers: { 'x-real-ip': '203.0.113.7' } }))
        .status
    ).toBe(429)
    expect((await app.request('/probe', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/probe', { method: 'POST' })).status).toBe(429)
  })
})
