import { describe, expect, it } from 'vitest'
import { hasSufficientWindowsFirewallRemoteScope } from './windows-firewall-remote-scope'

type RuleScope = { remoteAddresses: unknown }

function rule(remoteAddresses: unknown): RuleScope {
  return { remoteAddresses }
}

describe('Windows firewall remote-address scope', () => {
  it.each([['Any'], ['any'], ['LocalSubnet']])('accepts the documented %s scope', (scope) => {
    expect(hasSufficientWindowsFirewallRemoteScope([rule(scope)], undefined, undefined)).toBe(true)
  })

  it.each([['Any4'], ['LocalSubnet4']])(
    'accepts address-family-specific %s on the selected IPv4 interface',
    (scope) => {
      expect(hasSufficientWindowsFirewallRemoteScope([rule([scope])], '192.168.0.108', 24)).toBe(
        true
      )
    }
  )

  it('keeps address-family-specific keywords on the selected interface family', () => {
    expect(hasSufficientWindowsFirewallRemoteScope([rule(['Any6'])], 'fd7a:115c:a1e0::5', 64)).toBe(
      true
    )
    expect(
      hasSufficientWindowsFirewallRemoteScope([rule(['LocalSubnet6'])], 'fd7a:115c:a1e0::5', 64)
    ).toBe(true)
    expect(
      hasSufficientWindowsFirewallRemoteScope([rule(['LocalSubnet6'])], '192.168.0.108', 24)
    ).toBe(false)
  })

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

  it('does not infer explicit scope coverage without selected interface subnet data', () => {
    expect(
      hasSufficientWindowsFirewallRemoteScope([rule(['192.168.0.0/24'])], undefined, undefined)
    ).toBe(false)
    expect(
      hasSufficientWindowsFirewallRemoteScope([rule(['192.168.0.0/24'])], '192.168.0.108', 40)
    ).toBe(false)
    expect(
      hasSufficientWindowsFirewallRemoteScope([rule(['100.64.0.0/10'])], '100.64.1.20', 32)
    ).toBe(false)
  })

  it.each([
    undefined,
    null,
    [],
    {},
    [rule(undefined)],
    [rule([])],
    [rule([''])],
    [rule(['not-an-address'])],
    [{ remoteAddresses: [42] }]
  ])('rejects malformed or empty structured output %#', (rules) => {
    expect(hasSufficientWindowsFirewallRemoteScope(rules, '192.168.0.108', 24)).toBe(false)
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

  it('accepts PowerShell single-object and single-string JSON shapes', () => {
    expect(
      hasSufficientWindowsFirewallRemoteScope(
        { remoteAddresses: '192.168.0.0/24' },
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

  it('fails address-family keywords closed when the interface family is unknown', () => {
    expect(hasSufficientWindowsFirewallRemoteScope([rule(['Any'])], undefined, undefined)).toBe(
      true
    )
    expect(hasSufficientWindowsFirewallRemoteScope([rule(['Any4'])], undefined, undefined)).toBe(
      false
    )
    expect(hasSufficientWindowsFirewallRemoteScope([rule(['Any6'])], undefined, undefined)).toBe(
      false
    )
  })

  it.each([['Intranet'], ['DNS'], ['DHCP'], ['DefaultGateway'], ['PlayToDevice']])(
    'fails the policy-defined %s keyword closed rather than assuming subnet coverage',
    (scope) => {
      expect(hasSufficientWindowsFirewallRemoteScope([rule([scope])], '192.168.0.108', 24)).toBe(
        false
      )
    }
  )
})
