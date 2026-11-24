import { describe, expect, it } from 'vitest'
import { clientIpFromForwardedFor, clientIpPolicy } from './client-ip-rate-limit.js'
import { resolvePublicUrlProxyAddresses } from './public-url-proxy-addresses.js'

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
})

describe('resolvePublicUrlProxyAddresses', () => {
  it('returns both address families and survives one failing', async () => {
    const resolver = {
      resolve4: async () => [LB],
      resolve6: async () => {
        throw new Error('ENODATA')
      }
    }
    await expect(resolvePublicUrlProxyAddresses('https://push.example', resolver)).resolves.toEqual(
      [LB]
    )
  })
})
