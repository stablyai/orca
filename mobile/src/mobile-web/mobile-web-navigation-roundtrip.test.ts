import { describe, expect, it, vi } from 'vitest'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS } from './mobile-web-production-navigation-grants'

describe('mobile web navigation round trip', () => {
  it('carries named shell intent without host identity', async () => {
    const route = vi.fn()
    const reconnect = vi.fn()
    const removeHost = vi.fn()
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_NAVIGATION_GRANTS],
      isConnected: () => false,
      navigationAuthority: {
        route,
        reconnect,
        removeHost
      }
    })

    await expect(client.navigationRoute({ destination: 'hostPicker' })).resolves.toBeNull()
    await expect(client.navigationRoute({ destination: 'pairingRepair' })).resolves.toBeNull()
    await expect(client.navigationReconnect()).resolves.toBeNull()
    await expect(
      client.navigationRemoveHost({ confirmation: 'remove-paired-host' })
    ).resolves.toBeNull()

    expect(route).toHaveBeenCalledWith('hostPicker')
    expect(route).toHaveBeenCalledWith('pairingRepair')
    expect(reconnect).toHaveBeenCalledWith()
    expect(removeHost).toHaveBeenCalledWith()
  })
})
