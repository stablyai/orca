import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'

const registry = (reconnectGraceMs?: number): BrowserHostLeaseRegistry =>
  new BrowserHostLeaseRegistry({
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    reconnectGraceMs
  })

afterEach(() => {
  vi.useRealTimers()
})

describe('BrowserHostLeaseRegistry', () => {
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
})
