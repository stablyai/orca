import { describe, expect, it, vi } from 'vitest'
import { clientIpFromForwardedFor, clientIpPolicy } from './client-ip-rate-limit.js'
import { resolvePublicUrlProxyAddresses } from './public-url-proxy-addresses.js'
import { parseTrustedProxy } from './trusted-proxy-addresses.js'
import { loadPushConfig } from '../config.js'

const LB = '203.0.113.10'

describe('clientIpFromForwardedFor', () => {
  it('keys each client behind the load balancer on its own address, even with hops left at 0', () => {
    const policy = clientIpPolicy({ trustedProxyHops: 0, trustedProxyAddresses: [LB] })
    expect(clientIpFromForwardedFor(`198.51.100.1, ${LB}`, policy)).toBe('198.51.100.1')
    expect(clientIpFromForwardedFor(`198.51.100.2, ${LB}`, policy)).toBe('198.51.100.2')
  })

  it('never lets a caller pick its own bucket by forging earlier hops', () => {
    const policy = clientIpPolicy({ trustedProxyHops: 0, trustedProxyAddresses: [LB] })
    expect(clientIpFromForwardedFor(`1.2.3.4, ${LB}, 198.51.100.1, ${LB}`, policy)).toBe(
      '198.51.100.1'
    )
    // Direct to Cloud Run: the appended peer is the caller, whatever it forged before.
    expect(clientIpFromForwardedFor(`${LB}, 198.51.100.1`, policy)).toBe('198.51.100.1')
  })

  it('counts a trusted address toward the hop count instead of skipping past the client', () => {
    const policy = clientIpPolicy({ trustedProxyHops: 1, trustedProxyAddresses: [LB] })
    expect(clientIpFromForwardedFor(`1.2.3.4, 198.51.100.1, ${LB}`, policy)).toBe('198.51.100.1')
  })

  it('matches IPv6 proxy addresses regardless of case', () => {
    const policy = clientIpPolicy({ trustedProxyHops: 0, trustedProxyAddresses: ['2001:DB8::A'] })
    expect(clientIpFromForwardedFor('2001:db8::1, 2001:db8::a', policy)).toBe('2001:db8::1')
  })

  it('matches proxy addresses written in another form', () => {
    const policy = clientIpPolicy({
      trustedProxyHops: 0,
      trustedProxyAddresses: ['2001:0db8:0:0:0:0:0:000a', `::ffff:${LB}`]
    })
    expect(clientIpFromForwardedFor('2001:db8::1, 2001:db8::a', policy)).toBe('2001:db8::1')
    expect(clientIpFromForwardedFor(`198.51.100.1, ${LB}`, policy)).toBe('198.51.100.1')
  })
})

describe('trusted proxy ranges', () => {
  it('skips hops inside a configured IPv4 range', () => {
    const policy = clientIpPolicy({
      trustedProxyHops: 0,
      trustedProxyAddresses: ['203.0.113.0/24']
    })
    expect(clientIpFromForwardedFor('198.51.100.1, 203.0.113.77', policy)).toBe('198.51.100.1')
    expect(clientIpFromForwardedFor('198.51.100.1, ::ffff:203.0.113.5', policy)).toBe(
      '198.51.100.1'
    )
  })

  it("skips any address in an IPv6 forwarding rule's /64 and nothing outside it", () => {
    const policy = clientIpPolicy({
      trustedProxyHops: 0,
      trustedProxyAddresses: ['2600:1901:0:1234::/64', LB]
    })
    expect(clientIpFromForwardedFor('2001:db8::1, 2600:1901:0:1234::abcd', policy)).toBe(
      '2001:db8::1'
    )
    expect(
      clientIpFromForwardedFor('2001:db8::1, 2600:1901:0:1234:ffff:ffff:ffff:ffff', policy)
    ).toBe('2001:db8::1')
    expect(clientIpFromForwardedFor('2001:db8::1, 2600:1901:0:1235::1', policy)).toBe(
      '2600:1901:0:1235::1'
    )
    // A single trusted address does not trust its neighbours.
    expect(clientIpFromForwardedFor('198.51.100.1, 203.0.113.11', policy)).toBe('203.0.113.11')
  })

  it('refuses malformed or overly broad entries', () => {
    for (const entry of [
      'push.example',
      '203.0.113.0/33',
      '203.0.113.0/0',
      '203.0.113.7/24',
      '2600:1901:0:1234::1/64',
      '2600:1901::/129',
      '203.0.113.0/',
      '203.0.113.0/024',
      'fe80::1%eth0'
    ]) {
      expect(parseTrustedProxy(entry).ok, entry).toBe(false)
    }
    expect(parseTrustedProxy('2600:1901:0:1234:0000::/64')).toEqual({
      ok: true,
      proxy: {
        kind: 'range',
        range: expect.objectContaining({ family: 6, prefix: 64, text: '2600:1901:0:1234::/64' })
      }
    })
  })

  it('rejects a bad ORCA_PUSH_TRUSTED_PROXY_ADDRESSES at startup and names the entry', () => {
    const env = {
      ORCA_PUSH_PUBLIC_URL: 'https://push.example',
      ORCA_PUSH_FCM_PROJECT_ID: 'orca-test',
      ORCA_PUSH_TRUSTED_PROXY_ADDRESSES: `${LB}, 2600:1901:0:1234::1/64`
    }
    expect(() => loadPushConfig(env)).toThrow(/2600:1901:0:1234::1\/64.*host bits are set/)
    expect(
      loadPushConfig({ ...env, ORCA_PUSH_TRUSTED_PROXY_ADDRESSES: `${LB}, 2600:1901:0:1234::/64` })
        .trustedProxyAddresses
    ).toEqual([LB, '2600:1901:0:1234::/64'])
  })
})

describe('resolvePublicUrlProxyAddresses', () => {
  const fail = async (): Promise<string[]> => {
    throw new Error('ETIMEOUT')
  }

  it('returns both address families and survives one failing', async () => {
    const resolver = { resolve4: async () => [LB], resolve6: fail }
    await expect(
      resolvePublicUrlProxyAddresses('https://push.example', { resolver, required: true })
    ).resolves.toEqual([LB])
  })

  it('retries when both families fail, then fails startup instead of trusting nothing', async () => {
    let calls = 0
    const flaky = {
      resolve4: async () => (++calls < 2 ? fail() : [LB]),
      resolve6: fail
    }
    await expect(
      resolvePublicUrlProxyAddresses('https://push.example', {
        resolver: flaky,
        required: true,
        retryDelayMs: 0
      })
    ).resolves.toEqual([LB])

    const down = { resolve4: vi.fn(fail), resolve6: fail }
    await expect(
      resolvePublicUrlProxyAddresses('https://push.example', {
        resolver: down,
        required: true,
        attempts: 3,
        retryDelayMs: 0
      })
    ).rejects.toThrow(/ORCA_PUSH_TRUSTED_PROXY_ADDRESSES/)
    expect(down.resolve4).toHaveBeenCalledTimes(3)
  })
})
