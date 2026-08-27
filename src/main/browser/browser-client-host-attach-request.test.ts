import { describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import { createBrowserClientHostAttachRequest } from './browser-client-host-attach-request'

const pairing = {
  v: 2,
  endpoint: 'ws://127.0.0.1:6768',
  deviceToken: 'device-token',
  publicKeyB64: 'public-key',
  pairedDeviceId: 'device-a',
  scope: 'runtime'
} as PairingOffer

describe('browser client host attach request', () => {
  it('omits unencodable inventory without changing legacy page-command negotiation', () => {
    const onPageCommand = vi.fn(() => ({ status: 'completed' as const }))
    const attach = createBrowserClientHostAttachRequest({
      pairing,
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview'],
      pageCommandProtocolVersion: 1,
      onPageCommand,
      pageInventoryProtocolVersion: 1,
      leaseReconnectProtocolVersion: 1,
      getPageInventory: () => [
        {
          authorityRuntimeId: 'runtime-old',
          authorityEpoch: 'epoch-old',
          browserHostClientId: 'host-a',
          browserHostGeneration: 2,
          browserPageId: 'page-a',
          pageHostGeneration: 3,
          browserProfileId: '\0'.repeat(256),
          executionHostKey: 'native:runtime-old:1',
          state: 'active'
        }
      ]
    })

    expect(attach.pageCommandProtocolVersion).toBe(1)
    expect(attach.pageInventoryProtocolVersion).toBeUndefined()
    expect(attach.params).toMatchObject({ pageCommandProtocolVersion: 1 })
    expect(attach.params).not.toHaveProperty('pageInventoryProtocolVersion')
    expect(attach.params).not.toHaveProperty('pageInventory')
    expect(attach.params).not.toHaveProperty('leaseReconnectProtocolVersion')
  })

  it('includes reconnect negotiation only beside an encoded inventory snapshot', () => {
    const attach = createBrowserClientHostAttachRequest({
      pairing,
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview'],
      pageInventoryProtocolVersion: 1,
      leaseReconnectProtocolVersion: 1,
      getPageInventory: () => []
    })

    expect(attach).toMatchObject({
      pageInventoryProtocolVersion: 1,
      leaseReconnectProtocolVersion: 1,
      params: {
        pageInventoryProtocolVersion: 1,
        pageInventory: [],
        leaseReconnectProtocolVersion: 1
      }
    })
  })
})
