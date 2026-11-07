import { describe, expect, it } from 'vitest'
import { classifyNetworkSource, networkSourceKey } from './network-source-class'

describe('classifyNetworkSource', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.8.9.10', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.254', 'private'],
    ['192.168.1.20', 'private'],
    ['169.254.10.10', 'private'],
    ['::ffff:192.168.1.20', 'private'],
    ['::FFFF:10.0.0.1', 'private'],
    ['fd12:3456:789a::1', 'private'],
    ['fe80::1', 'private'],
    ['fe80::1%en0', 'private'],
    ['100.64.0.1', 'tailnet'],
    ['100.127.255.254', 'tailnet'],
    ['::ffff:100.100.100.100', 'tailnet'],
    ['fd7a:115c:a1e0::1', 'tailnet'],
    ['fd7a:115c:a1e0:ab12:4843:cd96:6258:b240', 'tailnet'],
    ['fd7a:115c:a1e1::1', 'private'],
    ['8.8.8.8', 'public'],
    ['172.32.0.1', 'public'],
    ['100.128.0.1', 'public'],
    ['192.169.0.1', 'public'],
    ['::ffff:203.0.113.9', 'public'],
    ['2001:4860:4860::8888', 'public']
  ])('%s is %s', (address, expected) => {
    expect(classifyNetworkSource(address)).toBe(expected)
  })

  it('has no class for a missing or malformed address', () => {
    expect(classifyNetworkSource(undefined)).toBeNull()
    expect(classifyNetworkSource('not-an-ip')).toBeNull()
  })
})

describe('networkSourceKey', () => {
  it('keys IPv4 by host, unmapping dual-stack peers', () => {
    expect(networkSourceKey('::ffff:203.0.113.9')).toBe('203.0.113.9')
    expect(networkSourceKey('203.0.113.9')).toBe('203.0.113.9')
  })

  it('keys IPv6 by /64', () => {
    expect(networkSourceKey('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64')
    expect(networkSourceKey('2001:DB8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64')
    expect(networkSourceKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(networkSourceKey('64:ff9b::192.0.2.1')).toBe('64:ff9b:0:0::/64')
  })
})
