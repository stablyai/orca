import { describe, expect, it, vi } from 'vitest'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_NATIVE_GRANTS } from './mobile-web-production-native-grants'

describe('settings native bridge roundtrip', () => {
  it('keeps notification primitives available without a host connection', async () => {
    let enabled = false
    const permission = vi.fn().mockResolvedValue({
      granted: true,
      status: 'granted',
      canAskAgain: true,
      authorizationReflectsUserChoice: false
    })
    const openSettings = vi.fn().mockResolvedValue(undefined)
    let index = 0
    const { client } = createMobileWebBridgeRoundtripFixture({
      grants: [...MOBILE_WEB_PRODUCTION_NATIVE_GRANTS],
      isConnected: () => false,
      createRequestId: () => String.fromCharCode(65 + index++).repeat(22),
      nativeAuthority: {
        settingsDevice: {
          permission,
          openSettings,
          preference: async (value) => {
            if (value !== undefined) {
              enabled = value
            }
            return { enabled }
          }
        }
      }
    })
    await expect(client.native.settingsDevice.permission()).resolves.toMatchObject({
      granted: true,
      authorizationReflectsUserChoice: false
    })
    expect(permission).toHaveBeenCalledExactlyOnceWith(false)
    await expect(client.native.settingsDevice.preference(true)).resolves.toEqual({ enabled: true })
    await expect(client.native.settingsDevice.preference()).resolves.toEqual({ enabled: true })
    await expect(client.native.settingsDevice.openSettings()).resolves.toBeNull()
    expect(openSettings).toHaveBeenCalledOnce()
  })
})
