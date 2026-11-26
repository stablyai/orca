import { describe, expect, it } from 'vitest'
import { withHostDirectEndpoints } from './host-direct-endpoint-refresh'
import type { StoredHostProfile } from './host-profile'

const row = (endpoint: string, origin?: StoredHostProfile['directEndpointOrigin']) =>
  ({
    id: 'h1',
    name: 'Desk',
    endpoint,
    ...(origin ? { directEndpointOrigin: origin } : {}),
    publicKeyB64: 'pk',
    lastConnected: 1
  }) satisfies StoredHostProfile

describe('withHostDirectEndpoints', () => {
  it('follows a desktop address only after the desktop has listed the saved one as its own', () => {
    const paired = row('ws://192.168.1.5:6768')
    const learned = withHostDirectEndpoints(paired, ['ws://192.168.1.5:6768'])
    expect(learned).toEqual(row('ws://192.168.1.5:6768', 'host'))

    // DHCP moved the desktop: the saved LAN address is gone, so take its LAN replacement, not Tailscale.
    expect(
      withHostDirectEndpoints(learned, ['ws://100.101.1.2:6768', 'ws://192.168.1.9:6768'])
    ).toEqual(row('ws://192.168.1.9:6768', 'host'))
    // Unknown origin (paired before origins existed, or a tunnel) is never rewritten.
    expect(withHostDirectEndpoints(paired, ['ws://192.168.1.9:6768'])).toBe(paired)
  })

  it('keeps an address the desktop still lists even when it now prefers another', () => {
    const learned = row('ws://192.168.1.5:6768', 'host')
    expect(
      withHostDirectEndpoints(learned, ['ws://100.101.1.2:6768', 'ws://192.168.1.5:6768'])
    ).toBe(learned)
    expect(withHostDirectEndpoints(learned, [])).toBe(learned)
  })

  it('never rewrites an endpoint typed in Edit Host', () => {
    const typed = row('ws://192.168.1.5:7000', 'manual')
    expect(withHostDirectEndpoints(typed, ['ws://192.168.1.9:6768'])).toBe(typed)
    expect(withHostDirectEndpoints(typed, ['ws://192.168.1.5:7000'])).toBe(typed)
  })
})
