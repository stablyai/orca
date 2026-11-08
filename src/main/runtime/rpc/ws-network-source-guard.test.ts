import 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { PublicSourceRefusal } from './ws-network-source-guard'
import { OnLinkPrefixes, onLinkPrefixList } from './on-link-prefixes'

describe('PublicSourceRefusal', () => {
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
})
