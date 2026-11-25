import { expect, test } from 'vitest'

import { MobileWebBundleRouteSchema } from '../../../../src/shared/mobile-web-bundle/manifest-contract'
import { MOBILE_WEB_PAGE_ROUTES } from './mobile-web-page-routes.mjs'

// A route the contract rejects makes the desktop refuse the whole manifest, so every phone page fails to load.
test('every declared page route, grants included, passes the manifest contract', () => {
  for (const route of MOBILE_WEB_PAGE_ROUTES) {
    const parsed = MobileWebBundleRouteSchema.safeParse(route)
    expect(parsed.error?.issues, route.pathname).toBeUndefined()
  }
})
