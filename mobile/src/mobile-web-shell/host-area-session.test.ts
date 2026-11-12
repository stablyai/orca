import { describe, expect, it } from 'vitest'
import { computeMobileWebBundleId } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import { MobileWebBundleManifestReadSchema } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'

import { MANIFEST_WIRE } from './mobile-web-shell-session-test-fixtures'
import { routeViewOf, type MobileWebPageRoute } from './page-route-policy'

const HOST_ROUTE = '/h/host-1'
const SESSION_GRANTS = [
  'navigate',
  'storage',
  'externalLink',
  'haptics',
  'screencastBinary',
  'native.clipboard.write',
  'native.clipboard.read',
  'native.media.pick',
  'native.media.read',
  'native.media.release',
  'native.audio.start',
  'native.audio.read',
  'native.audio.stop'
]

function desktopRoutes(declares: boolean): MobileWebPageRoute[] {
  return [
    {
      pathname: '/h/[hostId]',
      grants: ['navigate', 'storage', 'externalLink', 'haptics'],
      ...(declares ? { canOwnHostArea: true } : {})
    },
    {
      pathname: '/h/[hostId]/tasks',
      grants: ['navigate', 'storage', 'externalLink', 'haptics', 'native.clipboard.write']
    },
    {
      pathname: '/h/[hostId]/files/[worktreeId]',
      grants: ['navigate', 'storage', 'externalLink', 'haptics']
    },
    {
      pathname: '/h/[hostId]/session/[worktreeId]',
      grants: SESSION_GRANTS,
      optionalGrants: ['externalNavigation']
    }
  ]
}

describe('the page declaring it can own the host area', () => {
  it.each(['/h/[hostId]', '/h/[...page]'])(
    'does not combine ownership declarations from a separate matching %s route',
    (acrossLayoutsPattern) => {
      const [host, ...details] = desktopRoutes(true)
      const routes = [
        host!,
        {
          pathname: acrossLayoutsPattern,
          grants: ['navigate'],
          canOwnHostAreaAcrossLayouts: true
        },
        ...details
      ]
      const parsed = MobileWebBundleManifestReadSchema.parse({
        ...MANIFEST_WIRE,
        buildId: computeMobileWebBundleId(MANIFEST_WIRE.assets),
        routes
      })
      expect(routeViewOf(parsed.routes, HOST_ROUTE, false).ownsHostArea).toBe(false)
      expect(routeViewOf(parsed.routes, HOST_ROUTE, false).routeGrants).toEqual([
        'navigate',
        'storage',
        'externalLink',
        'haptics'
      ])
      expect(routeViewOf(parsed.routes, HOST_ROUTE, true).ownsHostArea).toBe(true)
    }
  )

  it('hands host-route exits from legacy narrow detail sessions to the shell while keeping detail hops', () => {
    const pairs = routeViewOf(desktopRoutes(true), '/h/host-1/session/wt-1', false).pageRouteGrants
    expect(pairs.map((pair) => pair.pathname)).toEqual([
      '/h/[hostId]/tasks',
      '/h/[hostId]/files/[worktreeId]',
      '/h/[hostId]/session/[worktreeId]'
    ])
  })
})
