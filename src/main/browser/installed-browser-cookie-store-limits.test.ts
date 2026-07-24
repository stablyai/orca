import { describe, expect, it } from 'vitest'
import {
  assertInstalledBrowserCookieStoreWithinLimits,
  INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES,
  INSTALLED_BROWSER_COOKIE_STORE_MAX_COOKIES,
  InstalledBrowserCookieStoreLimitError
} from './installed-browser-cookie-store-limits'

describe('assertInstalledBrowserCookieStoreWithinLimits', () => {
  it('accepts the exact cookie-count and byte boundaries', () => {
    expect(
      assertInstalledBrowserCookieStoreWithinLimits(
        BigInt(INSTALLED_BROWSER_COOKIE_STORE_MAX_COOKIES),
        BigInt(INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES)
      )
    ).toBe(INSTALLED_BROWSER_COOKIE_STORE_MAX_COOKIES)
  })

  it.each([
    {
      kind: 'cookies',
      cookies: INSTALLED_BROWSER_COOKIE_STORE_MAX_COOKIES + 1,
      bytes: INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES
    },
    {
      kind: 'bytes',
      cookies: INSTALLED_BROWSER_COOKIE_STORE_MAX_COOKIES,
      bytes: INSTALLED_BROWSER_COOKIE_STORE_MAX_BYTES + 1
    }
  ])('rejects one $kind over its boundary', ({ kind, cookies, bytes }) => {
    expect(() => assertInstalledBrowserCookieStoreWithinLimits(cookies, bytes)).toThrow(
      expect.objectContaining({
        name: InstalledBrowserCookieStoreLimitError.name,
        kind
      })
    )
  })
})
