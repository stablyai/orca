import { describe, expect, it } from 'vitest'
import { MOBILE_WEB_PAGE_VERSION } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_PAGE_VERSION_FLOOR } from './mobile-web-bundle-compat'

describe("the shell's page floor", () => {
  it('never requires a page newer than the one built beside this shell', () => {
    expect(MOBILE_WEB_PAGE_VERSION_FLOOR).toBeLessThanOrEqual(MOBILE_WEB_PAGE_VERSION)
  })
})
