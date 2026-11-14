import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserHostLeaseRegistry } from './browser-host-lease-registry'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'

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

it('refuses a long navigation for an older desktop while keeping its short commands usable', async () => {
  const leases = registry()
  const host = leases.attach({
    browserHostClientId: 'host-a',
    connectionId: 'connection-a',
    pairedDeviceId: 'device-a',
    hostCapabilities: ['webview'],
    pageCommandProtocolVersion: 1,
    pageInventoryProtocolVersion: 1,
    pageInventory: [],
    pageReconciliationProtocolVersion: 1
  })
  const delivered: BrowserClientHostCommandEvent[] = []
  leases.attachCommandDelivery(host.lease, (event) => {
    delivered.push(event)
    leases.settleClientPageCommand(host.lease, {
      ...event,
      result: {
        status: 'completed',
        ...(event.command.type === 'navigate' ? { value: event.command.url } : {})
      }
    })
  })
  try {
    const placement = await leases.createClientPage({
      browserPageId: 'page-a',
      browserHostClientId: 'host-a',
      pairedDeviceId: 'device-a',
      browserProfileId: 'default',
      executionHostKey: 'host-key'
    })
    const proof = { ...host.lease, ...placement, browserPageId: 'page-a' }
    const before = delivered.length
    expect(() =>
      leases.issueClientPageCommand(proof, {
        type: 'navigate',
        url: `https://example.internal/${'x'.repeat(8300)}`
      })
    ).toThrow()
    expect(delivered).toHaveLength(before)
    const next = leases.issueClientPageCommand(proof, {
      type: 'navigate',
      url: 'https://example.internal/short'
    })
    await expect(next.result).resolves.toEqual({
      status: 'completed',
      value: 'https://example.internal/short'
    })
    expect(leases.select('host-a')).toEqual(host.lease)
  } finally {
    host.release()
  }
})
