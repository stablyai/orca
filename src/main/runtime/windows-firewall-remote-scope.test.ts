import { describe, expect, it } from 'vitest'
import { hasSufficientWindowsFirewallRemoteScope } from './windows-firewall-remote-scope'

type RuleScope = { remoteAddresses: unknown }

function rule(remoteAddresses: unknown): RuleScope {
  return { remoteAddresses }
}

describe('Windows firewall remote-address scope', () => {
  it.each([
    ['192.168.0.0/24', '192.168.0.108', 24],
    ['192.168.0.0-192.168.0.255', '192.168.0.108', 24],
    ['fd7a:115c:a1e0::/64', 'fd7a:115c:a1e0::5', 64],
    ['fd7a:115c:a1e0::-fd7a:115c:a1e0:0:ffff:ffff:ffff:ffff', 'fd7a:115c:a1e0::5', 64]
  ])('accepts explicit scope %s covering the selected local subnet', (scope, address, prefix) => {
    expect(hasSufficientWindowsFirewallRemoteScope([rule([scope])], address, prefix)).toBe(true)
  })

  it.each([
    ['192.168.1.0/24', '192.168.0.108', 24],
    ['192.168.0.64/26', '192.168.0.108', 24],
    ['192.168.0.108', '192.168.0.108', 24],
    ['fd7a:115c:a1e1::/64', 'fd7a:115c:a1e0::5', 64],
    ['Internet', '192.168.0.108', 24]
  ])('rejects restrictive or unsupported scope %s', (scope, address, prefix) => {
    expect(hasSufficientWindowsFirewallRemoteScope([rule([scope])], address, prefix)).toBe(false)
  })

  it('evaluates each rule independently instead of merging partial ranges', () => {
    expect(
      hasSufficientWindowsFirewallRemoteScope(
        [rule(['192.168.0.0-192.168.0.127']), rule(['192.168.0.128-192.168.0.255'])],
        '192.168.0.108',
        24
      )
    ).toBe(false)
    expect(
      hasSufficientWindowsFirewallRemoteScope(
        [rule(['192.168.1.0/24']), rule(['192.168.0.0/24'])],
        '192.168.0.108',
        24
      )
    ).toBe(true)
  })

  it('accepts dotted-netmask CIDR with a contiguous mask and rejects a holey one', () => {
    expect(
      hasSufficientWindowsFirewallRemoteScope(
        [rule(['192.168.0.0/255.255.255.0'])],
        '192.168.0.108',
        24
      )
    ).toBe(true)
    expect(
      hasSufficientWindowsFirewallRemoteScope(
        [rule(['192.168.0.0/255.0.255.0'])],
        '192.168.0.108',
        24
      )
    ).toBe(false)
  })

  it('treats a single-host (/32) interface as coverable only by Any/LocalSubnet keywords', () => {
    // A /32 subnet is just the desktop itself, so an explicit range cannot prove
    // the phone (a different host) is allowed — only the keywords can.
    expect(hasSufficientWindowsFirewallRemoteScope([rule(['Any'])], '100.64.1.20', 32)).toBe(true)
    expect(
      hasSufficientWindowsFirewallRemoteScope([rule(['LocalSubnet'])], '100.64.1.20', 32)
    ).toBe(true)
    expect(
      hasSufficientWindowsFirewallRemoteScope([rule(['100.64.0.0/10'])], '100.64.1.20', 32)
    ).toBe(false)
  })
})
