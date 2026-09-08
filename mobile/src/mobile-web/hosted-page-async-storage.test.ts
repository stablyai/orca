import { afterEach, describe, expect, it, vi } from 'vitest'
import storage from './hosted-page-async-storage'
import { setMobileWebPagePreferencesClient } from '../../../src/mobile-web/src/mobile-web-page-preferences-channel'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
afterEach(() => setMobileWebPagePreferencesClient(null))
describe('hosted page preference adapter', () => {
  it('uses the bounded native namespace and preserves callback semantics', async () => {
    const pagePreferences = vi
      .fn()
      .mockResolvedValueOnce({ entries: [['setting', 'saved']] })
      .mockResolvedValueOnce({ updated: true })
    setMobileWebPagePreferencesClient({
      native: { pagePreferences }
    } as unknown as MobileWebBridgeClient)
    const callback = vi.fn()
    expect(await storage.getItem('setting', callback)).toBe('saved')
    expect(callback).toHaveBeenCalledWith(null, 'saved')
    await storage.setItem('setting', 'next')
    expect(pagePreferences.mock.calls).toEqual([
      [{ namespace: 'expo.preferences', action: 'read', keys: ['setting'] }],
      [{ namespace: 'expo.preferences', action: 'write', entries: [['setting', 'next']] }]
    ])
  })

  it('folds concurrent reads of one tick into a single bridge request', async () => {
    const pagePreferences = vi.fn(
      async (payload: { action: string; keys?: string[] }): Promise<unknown> =>
        payload.action === 'read'
          ? { entries: payload.keys!.map((key) => [key, `${key}-value`]) }
          : { updated: true }
    )
    setMobileWebPagePreferencesClient({
      native: { pagePreferences }
    } as unknown as MobileWebBridgeClient)
    const keys = ['a', 'b', 'c', 'd', 'e']
    expect(await Promise.all(keys.map((key) => storage.getItem(key)))).toEqual(
      keys.map((key) => `${key}-value`)
    )
    expect(pagePreferences.mock.calls).toEqual([
      [{ namespace: 'expo.preferences', action: 'read', keys }]
    ])
  })

  it('keeps writes ordered after reads and splits past the request key limit', async () => {
    const pagePreferences = vi.fn(
      async (payload: { action: string; keys?: string[] }): Promise<unknown> =>
        payload.action === 'read'
          ? { entries: (payload.keys ?? []).map((key) => [key, null]) }
          : { updated: true }
    )
    setMobileWebPagePreferencesClient({
      native: { pagePreferences }
    } as unknown as MobileWebBridgeClient)
    const many = Array.from({ length: 70 }, (_, index) => `k${index}`)
    await Promise.all([storage.getItem('a'), storage.setItem('b', '1'), storage.multiGet(many)])
    expect(
      pagePreferences.mock.calls.map(([payload]) => [payload.action, payload.keys?.length ?? 1])
    ).toEqual([
      ['read', 1],
      ['write', 1],
      ['read', 64],
      ['read', 6]
    ])
  })

  it('fails clearly on old shells rather than pretending writes persisted', async () => {
    const error = new Error('unsupported_capability')
    setMobileWebPagePreferencesClient({
      native: { pagePreferences: vi.fn().mockRejectedValue(error) }
    } as unknown as MobileWebBridgeClient)
    const callback = vi.fn()
    await expect(storage.setItem('setting', 'next', callback)).rejects.toBe(error)
    expect(callback).toHaveBeenCalledWith(error)
  })

  it('discards a response after document replacement', async () => {
    const pending = Promise.withResolvers<unknown>()
    const pagePreferences = vi.fn(() => pending.promise)
    setMobileWebPagePreferencesClient({
      native: { pagePreferences }
    } as unknown as MobileWebBridgeClient)
    const read = storage.getItem('setting')
    await vi.waitFor(() => expect(pagePreferences).toHaveBeenCalled())
    setMobileWebPagePreferencesClient(null)
    pending.resolve({ entries: [['setting', 'from-old-host']] })
    await expect(read).rejects.toMatchObject({ code: 'cancelled' })
  })
})
