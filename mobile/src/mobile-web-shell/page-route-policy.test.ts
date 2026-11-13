import { describe, expect, it } from 'vitest'

import {
  matchesRoutePattern,
  grantsForRoute,
  routePatternRefusal,
  routeViewOf
} from './page-route-policy'
import { BridgePageRouteGrantsSchema } from './bridge/bridge-page-route-grants'
import { MobileWebBundleManifestReadSchema } from '../transport/web-bundle/mobile-web-bundle-reply-schemas'
import { MANIFEST_WIRE } from './mobile-web-shell-session-test-fixtures'

function pageRoutesOf(routes: Parameters<typeof routeViewOf>[0]): string[] {
  return routeViewOf(routes, '/h/host-1').pageRoutes
}

// Accept trailing rest patterns from future desktops so already-installed shells can serve new catch-all screens.
describe('a pattern with a rest segment', () => {
  const PATTERN = '/h/[hostId]/[...page]'

  it('matches one segment and as many as follow it', () => {
    expect(matchesRoutePattern('/h/a/x', PATTERN)).toBe(true)
    expect(matchesRoutePattern('/h/a/x/y', PATTERN)).toBe(true)
  })

  // Expo Router 55.0.18 formats rest as ((.*\/)) after adding a trailing slash; the tail needs its own slash, so zero segments cannot match.
  it('does not match the prefix it sits on, which is a different screen', () => {
    expect(matchesRoutePattern('/h/a', PATTERN)).toBe(false)
    expect(matchesRoutePattern('/h/a/', PATTERN)).toBe(false)
  })

  it('refuses an empty segment in the tail, as the dynamic segments already do', () => {
    expect(matchesRoutePattern('/h/a/x//y', PATTERN)).toBe(false)
    expect(matchesRoutePattern('/h/a/x/y/', PATTERN)).toBe(false)
  })

  // Refuse repeated/non-trailing rest explicitly instead of guessing a newer pattern’s meaning.
  it('refuses a rest segment that is not the last one', () => {
    expect(routePatternRefusal('/h/[...page]/tail')).toBe('rest-segment-not-last')
    expect(matchesRoutePattern('/h/a/tail', '/h/[...page]/tail')).toBe(false)
  })

  it('refuses a pattern carrying two of them', () => {
    expect(routePatternRefusal('/h/[...a]/[...b]')).toBe('rest-segments-repeated')
    expect(matchesRoutePattern('/h/x/y', '/h/[...a]/[...b]')).toBe(false)
  })

  // Prefer the exact row over an overlapping rest row so catch-all grants cannot override the screen’s own declaration.
  it("gives an exactly declared route its own grants and not the rest route's", () => {
    const routes = [
      { pathname: PATTERN, grants: ['navigate', 'storage', 'externalLink'] },
      { pathname: '/h/[hostId]/tasks', grants: ['navigate'] }
    ]
    expect(grantsForRoute(routes, '/h/a/tasks')).toEqual(['navigate'])
    expect(grantsForRoute(routes, '/h/a/anything/else')).toEqual([
      'navigate',
      'storage',
      'externalLink'
    ])
  })
})

describe('the grants this app implements', () => {
  // Narrow declared grants before init so unimplemented and ungranted both reach host enforcement as absent.
  it('drops a grant the route declared and this shell does not implement', () => {
    const routes = [
      { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate', 'aGrantFromTheFuture'] },
      { pathname: '/h/[hostId]/tasks', grants: ['navigate'] }
    ]
    expect(grantsForRoute(routes, '/h/host-1/session/wt-1')).toEqual(['navigate'])
    expect(pageRoutesOf(routes)).toEqual(['/h/[hostId]/tasks'])
  })
})

// Project loose desktop route entries into strict bridge pairs so future manifest fields cannot reject the whole session.
describe('the pairs a session publishes to the page', () => {
  // Use known optionalGrants and future renderer fields to prove neither leaks into the strict pair schema.
  const carryingAnUnreadField = [
    {
      pathname: '/h/[hostId]',
      grants: ['navigate', 'storage'],
      optionalGrants: ['screencastBinary'],
      renderer: 'someLaterDesktopsField'
    }
  ]

  it('publishes pairs the host schema accepts, so the session is not refused with them', () => {
    const routes = MobileWebBundleManifestReadSchema.parse({
      ...MANIFEST_WIRE,
      routes: carryingAnUnreadField
    }).routes
    const { pageRouteGrants } = routeViewOf(routes, '/h/host-1')
    const parsed = BridgePageRouteGrantsSchema.safeParse(pageRouteGrants)
    expect(pageRouteGrants).toEqual([
      { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'screencastBinary'] }
    ])
    expect(parsed.success).toBe(true)
  })
})

describe('a route that declares an optional grant', () => {
  const pathname = '/h/[hostId]/session/[worktreeId]'
  const opened = '/h/host-1/session/wt-1'

  it('drops an optional name this shell does not implement, and serves the route anyway', () => {
    const fromTheFuture = [
      { pathname, grants: ['navigate', 'storage'], optionalGrants: ['aGrantFromTheFuture'] }
    ]
    expect(grantsForRoute(fromTheFuture, opened)).toEqual(['navigate', 'storage'])
    // Missing optional grants hide an affordance; missing required grants leave the screen native.
    expect(pageRoutesOf(fromTheFuture)).toEqual([pathname])
  })
})
