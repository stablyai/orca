import { describe, expect, it } from 'vitest'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'

const registry = (): BrowserHostLeaseRegistry =>
  new BrowserHostLeaseRegistry({ authorityRuntimeId: 'runtime-a', authorityEpoch: 'epoch-a' })

describe('BrowserHostLeaseRegistry', () => {
  it('selects only an exact host when more than one lease is live', () => {
    const leases = registry()
    leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    leases.attach({
      browserHostClientId: 'host-b',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-b',
      hostCapabilities: ['webview']
    })

    expect(() => leases.select()).toThrow('browser_host_ambiguous')
    expect(leases.select('host-a')).toMatchObject({
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1
    })
    expect(() => leases.select('missing')).toThrow('browser_host_unavailable')
  })

  it('fences a same-device replacement without letting old cleanup remove it', async () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const replacement = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    await expect(first.whenFenced).resolves.toBe('replaced')
    expect(replacement.lease.browserHostGeneration).toBe(2)
    first.release()
    expect(leases.select('host-a')).toEqual(replacement.lease)
    expect(() =>
      leases.attach({
        browserHostClientId: 'host-a',
        connectionId: 'connection-c',
        pairedDeviceId: 'device-b',
        hostCapabilities: ['webview']
      })
    ).toThrow('browser_host_identity_conflict')
  })

  it('admits only one distinct browser host per authenticated connection', () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    expect(() =>
      leases.attach({
        browserHostClientId: 'host-b',
        connectionId: 'connection-a',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      })
    ).toThrow('browser_host_connection_capacity')
    first.release()
    expect(
      leases.attach({
        browserHostClientId: 'host-b',
        connectionId: 'connection-a',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      }).lease.browserHostClientId
    ).toBe('host-b')
  })

  it('bounds distinct browser hosts per paired device without starving another device', () => {
    const leases = registry()
    const handles = Array.from({ length: 4 }, (_, index) =>
      leases.attach({
        browserHostClientId: `host-${index}`,
        connectionId: `connection-${index}`,
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      })
    )

    expect(() =>
      leases.attach({
        browserHostClientId: 'host-overflow',
        connectionId: 'connection-overflow',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      })
    ).toThrow('browser_host_device_capacity')
    expect(
      leases.attach({
        browserHostClientId: 'host-other-device',
        connectionId: 'connection-other-device',
        pairedDeviceId: 'device-b',
        hostCapabilities: ['webview']
      }).lease.browserHostClientId
    ).toBe('host-other-device')
    handles[0]!.release()
    expect(
      leases.attach({
        browserHostClientId: 'host-after-release',
        connectionId: 'connection-after-release',
        pairedDeviceId: 'device-a',
        hostCapabilities: ['webview']
      }).lease.browserHostClientId
    ).toBe('host-after-release')
  })

  it('allocates monotonic page generations and rejects a stale host generation', () => {
    const leases = registry()
    const first = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    expect(leases.placeServerPage('page-a')).toEqual({ kind: 'server' })
    expect(leases.placeClientPage('page-a', 'host-a')).toEqual({
      kind: 'client',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pageHostGeneration: 1
    })
    first.release()
    leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-b',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })

    expect(() =>
      leases.requireLease({
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'host-a',
        browserHostGeneration: 1,
        pairedDeviceId: 'device-a'
      })
    ).toThrow('browser_host_lease_stale')
    expect(leases.placeClientPage('page-a', 'host-a')).toMatchObject({
      browserHostGeneration: 2,
      pageHostGeneration: 2
    })
  })

  it('retires closed page placement without reusing its generation', () => {
    const leases = registry()
    leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const first = leases.placeClientPage('page-a', 'host-a')

    expect(leases.retirePage('page-a', first)).toBe(true)

    expect(leases.getPlacement('page-a')).toBeUndefined()
    expect(leases.placeClientPage('page-a', 'host-a')).toMatchObject({
      pageHostGeneration: first.kind === 'client' ? first.pageHostGeneration + 1 : Number.NaN
    })
  })

  it('does not let late cleanup retire a replacement or server placement', () => {
    const leases = registry()
    leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const first = leases.placeClientPage('page-a', 'host-a')
    const replacement = leases.placeClientPage('page-a', 'host-a')

    expect(leases.retirePage('page-a', first)).toBe(false)
    expect(leases.getPlacement('page-a')).toBe(replacement)
    const server = leases.placeServerPage('page-a')
    expect(leases.retirePage('page-a', replacement)).toBe(false)
    expect(leases.getPlacement('page-a')).toBe(server)
    expect(leases.retirePage('page-a', server)).toBe(true)
  })

  it('binds tunnel generations to the lease and fences replaced routes', async () => {
    const leases = registry()
    const host = leases.attach({
      browserHostClientId: 'host-a',
      connectionId: 'connection-a',
      pairedDeviceId: 'device-a',
      hostCapabilities: ['webview']
    })
    const identity = {
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1,
      pairedDeviceId: 'device-a',
      executionHostKey: 'native:runtime-a'
    }
    const firstRoute = leases.openTunnel(identity)
    const replacementRoute = leases.openTunnel(identity)

    expect(firstRoute.tunnelGeneration).toBe(1)
    expect(replacementRoute.tunnelGeneration).toBe(2)
    await expect(firstRoute.whenFenced).resolves.toBe('replaced')
    host.release()
    await expect(replacementRoute.whenFenced).resolves.toBe('lease_released')
    expect(() => leases.openTunnel(identity)).toThrow('browser_host_lease_required')
  })
})
