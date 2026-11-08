import { describe, expect, it, vi } from 'vitest'
import { admitPreAuth, sourceKey } from '../src/preauth'
import type { Env } from '../src/env'

const req = (ip?: string) => new Request('https://edge.test/v1/connect/x', { headers: ip ? { 'cf-connecting-ip': ip } : {} })

describe('pre-auth source key', () => {
  it('keys IPv4 by address and IPv6 by /64, in any spelling', () => {
    expect(sourceKey(req('203.0.113.9'))).toBe('203.0.113.9')
    expect(sourceKey(req('2001:db8:0:1::5'))).toBe('2001:db8:0:1::/64')
    expect(sourceKey(req('2001:0DB8:0000:0001:aaaa:bbbb:cccc:dddd'))).toBe('2001:db8:0:1::/64')
    expect(sourceKey(req('2001:db8::1'))).toBe('2001:db8:0:0::/64')
    expect(sourceKey(req('::1'))).toBe('0:0:0:0::/64')
    expect(sourceKey(req())).toBe('unknown')
  })
})

describe('pre-auth limiter', () => {
  const env = (limit: RateLimit['limit']) => ({ PREAUTH_LIMITER: { limit } }) as unknown as Env
  it('counts phone and data apart per source', async () => {
    const limit = vi.fn(async () => ({ success: true }))
    await admitPreAuth(env(limit), req('203.0.113.9'), 'phone')
    await admitPreAuth(env(limit), req('203.0.113.9'), 'data')
    expect(limit.mock.calls).toEqual([[{ key: 'phone:203.0.113.9' }], [{ key: 'data:203.0.113.9' }]])
  })
  it('refuses over the limit, fails open when the limiter errors, and passes without a binding', async () => {
    expect(await admitPreAuth(env(async () => ({ success: false })), req('203.0.113.9'), 'phone')).toBe(false)
    expect(await admitPreAuth(env(async () => { throw new Error('down') }), req('203.0.113.9'), 'phone')).toBe(true)
    expect(await admitPreAuth({} as Env, req('203.0.113.9'), 'phone')).toBe(true)
  })
})
