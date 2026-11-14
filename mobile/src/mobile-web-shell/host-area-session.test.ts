import { describe, expect, it } from 'vitest'
import { MobileWebBundleManifestReadSchema } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'

import { MANIFEST_WIRE } from './mobile-web-shell-session-test-fixtures'
import { routeViewOf } from './page-route-policy'

const HOST_ROUTE = '/h/host-1'

describe('the page declaring it can own the host area', () => {
  it('does not combine ownership declarations from separate matching routes', () => {
    const parsed = MobileWebBundleManifestReadSchema.parse({
      ...MANIFEST_WIRE,
      routes: [
        { pathname: '/h/[hostId]', grants: ['navigate'], canOwnHostArea: true },
        {
          pathname: '/h/[...page]',
          grants: ['navigate'],
          canOwnHostAreaAcrossLayouts: true
        },
        { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate'] }
      ]
    })
    expect(routeViewOf(parsed.routes, HOST_ROUTE, false).ownsHostArea).toBe(false)
    expect(routeViewOf(parsed.routes, HOST_ROUTE, true).ownsHostArea).toBe(true)
    expect(
      routeViewOf(parsed.routes, '/h/host-1/session/wt-1', false).pageRouteGrants.map(
        (pair) => pair.pathname
      )
    ).toContain('/h/[hostId]')
  })
})
