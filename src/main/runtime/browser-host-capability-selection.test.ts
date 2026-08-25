import { describe, expect, it } from 'vitest'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'

const registry = (): BrowserHostLeaseRegistry =>
  new BrowserHostLeaseRegistry({ authorityRuntimeId: 'runtime-a', authorityEpoch: 'epoch-a' })

describe('browser host capability selection', () => {
  it('selects the only host satisfying every requested capability', () => {
    const leases = registry()
    attach(leases, 'webview-only', ['webview'])
    attach(leases, 'commands', ['webview', 'commands.v1'])

    expect(leases.select(undefined, ['webview', 'commands.v1'])).toMatchObject({
      browserHostClientId: 'host-commands'
    })
    expect(() => leases.select('host-webview-only', ['commands.v1'])).toThrow(
      'browser_host_capability_unavailable'
    )
    expect(() => leases.select(undefined, ['mirror.v1'])).toThrow('browser_host_unavailable')
  })

  it('keeps multiple qualified hosts ambiguous without arbitrary routing', () => {
    const leases = registry()
    attach(leases, 'a', ['webview', 'commands.v1'])
    attach(leases, 'b', ['webview', 'commands.v1'])

    expect(() => leases.select(undefined, ['commands.v1'])).toThrow('browser_host_ambiguous')
  })

  it('requires webview plus page-specific capabilities before placement', () => {
    const leases = registry()
    attach(leases, 'a', ['webview'])

    expect(() => leases.placeClientPage('page-a', 'host-a', ['commands.v1'])).toThrow(
      'browser_host_capability_unavailable'
    )
    expect(leases.getPlacement('page-a')).toBeUndefined()
    attach(leases, 'a', ['webview', 'commands.v1'], 'connection-b')
    expect(leases.placeClientPage('page-a', 'host-a', ['commands.v1'])).toMatchObject({
      browserHostGeneration: 2,
      pageHostGeneration: 1
    })
  })

  it('rejects a client page on a host without webview support', () => {
    const leases = registry()
    attach(leases, 'a', ['commands.v1'])

    expect(() => leases.placeClientPage('page-a', 'host-a')).toThrow(
      'browser_host_capability_unavailable'
    )
    expect(leases.getPlacement('page-a')).toBeUndefined()
  })

  it('releases placement after a reconnect capability downgrade', () => {
    const leases = registry()
    attach(leases, 'a', ['webview', 'commands.v1'])
    leases.placeClientPage('page-a', 'host-a', ['commands.v1'])
    attach(leases, 'a', ['webview'], 'connection-b')

    expect(() =>
      leases.requireClientPage({
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserPageId: 'page-a',
        browserHostClientId: 'host-a',
        browserHostGeneration: 1,
        pageHostGeneration: 1
      })
    ).toThrow('browser_client_page_placement_required')
    expect(() => leases.placeClientPage('page-a', 'host-a', ['commands.v1'])).toThrow(
      'browser_host_capability_unavailable'
    )
    expect(leases.getPlacement('page-a')).toBeUndefined()
  })
})

function attach(
  leases: BrowserHostLeaseRegistry,
  suffix: string,
  hostCapabilities: readonly string[],
  connectionId = `connection-${suffix}`
): void {
  leases.attach({
    browserHostClientId: `host-${suffix}`,
    connectionId,
    pairedDeviceId: `device-${suffix}`,
    hostCapabilities
  })
}
