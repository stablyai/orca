import { BlockList } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { PublicSourceRefusal } from './ws-network-source-guard'
import { OnLinkPrefixes, onLinkPrefixList } from './on-link-prefixes'

const noOnLink = { contains: () => false }

describe('PublicSourceRefusal', () => {
  it('admits loopback, LAN, link-local and Tailscale peers', () => {
    const guard = new PublicSourceRefusal(noOnLink, () => 0, vi.fn())
    for (const address of [
      '127.0.0.1',
      '::1',
      '::ffff:10.0.0.4',
      '172.20.1.1',
      '192.168.0.10',
      '169.254.3.3',
      'fe80::1%en0',
      'fd00::1',
      '100.101.102.103',
      'fd7a:115c:a1e0::9'
    ]) {
      expect(guard.admit(address)).toBe(true)
    }
  })

  it('refuses public peers and logs the flag once an hour', () => {
    let now = 0
    const log = vi.fn()
    const guard = new PublicSourceRefusal(noOnLink, () => now, log)
    expect(guard.admit('::ffff:203.0.113.9')).toBe(false)
    expect(guard.admit('2001:db8::1')).toBe(false)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0]?.[0]).toContain('203.0.113.9')
    expect(log.mock.calls[0]?.[0]).toContain('--allow-public')

    now = 60 * 60_000
    expect(guard.admit('198.51.100.1')).toBe(false)
    expect(log).toHaveBeenCalledTimes(2)
  })

  it("admits global peers on the server's own interface prefixes", () => {
    const onLink = new OnLinkPrefixes(() =>
      onLinkPrefixList({
        en0: [
          {
            address: '2001:db8:aa:1::10',
            netmask: 'ffff:ffff:ffff:ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:01',
            internal: false,
            cidr: '2001:db8:aa:1::10/64',
            scopeid: 0
          },
          {
            address: '198.51.100.20',
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:01',
            internal: false,
            cidr: '198.51.100.20/24'
          },
          {
            // A misconfigured very wide prefix must not open the whole internet.
            address: '2001:db8:bb::1',
            netmask: 'ffff::',
            family: 'IPv6',
            mac: '00:00:00:00:00:01',
            internal: false,
            cidr: '2001:db8:bb::1/16',
            scopeid: 0
          }
        ]
      })
    )
    const guard = new PublicSourceRefusal(onLink, () => 0, vi.fn())
    expect(guard.admit('2001:db8:aa:1:5054:ff:fe12:3456')).toBe(true)
    expect(guard.admit('::ffff:198.51.100.77')).toBe(true)
    expect(guard.admit('2001:db8:aa:2::1')).toBe(false)
    expect(guard.admit('198.51.101.77')).toBe(false)
    expect(guard.admit('2001:db8:cc::1')).toBe(false)
  })

  it('re-reads interface prefixes after they change', () => {
    let now = 0
    let list = new BlockList()
    const onLink = new OnLinkPrefixes(
      () => list,
      () => now
    )
    expect(onLink.contains('2001:db8:aa:1::5')).toBe(false)

    list = new BlockList()
    list.addSubnet('2001:db8:aa:1::', 64, 'ipv6')
    expect(onLink.contains('2001:db8:aa:1::5')).toBe(false)
    now = 5_000
    expect(onLink.contains('2001:db8:aa:1::5')).toBe(true)
  })
})
