import { describe, expect, it, vi } from 'vitest'
import { createMobileWebBridgeRoundtripFixture } from './mobile-web-bridge-roundtrip-fixture'
import { MOBILE_WEB_PRODUCTION_GRANTS } from './mobile-web-production-grants'

describe('native page preference bridge', () => {
  it('forwards bounded preferences without requiring a connected execution host', async () => {
    const pagePreferences = vi.fn().mockResolvedValue({ entries: [['setting', '{"future":true}']] })
    const f = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      nativeAuthority: { pagePreferences },
      rpcClient: null,
      isConnected: () => false
    })
    const payload = { namespace: 'future.screen', action: 'read' as const, keys: ['setting'] }
    expect(await f.client.native.pagePreferences(payload)).toEqual({
      entries: [['setting', '{"future":true}']]
    })
    expect(pagePreferences).toHaveBeenCalledWith(payload)
  })

  it('rejects additional native storage selectors before invoking storage', async () => {
    const pagePreferences = vi.fn()
    const f = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS,
      nativeAuthority: { pagePreferences }
    })
    await expect(
      f.client.native.pagePreferences({
        namespace: 'settings',
        action: 'clear',
        hostIdentity: 'another-host'
      } as never)
    ).rejects.toMatchObject({ code: 'invalid_request' })
    expect(pagePreferences).not.toHaveBeenCalled()
  })

  it('reports unsupported storage on a legacy shell', async () => {
    const f = createMobileWebBridgeRoundtripFixture({
      grants: MOBILE_WEB_PRODUCTION_GRANTS.filter((grant) => grant.operation !== 'pagePreferences')
    })
    await expect(
      f.client.native.pagePreferences({ namespace: 'settings', action: 'keys' })
    ).rejects.toMatchObject({ code: 'unsupported_capability' })
  })
})
