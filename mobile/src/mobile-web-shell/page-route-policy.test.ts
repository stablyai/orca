import { describe, expect, it } from 'vitest'
import { MobileWebBundleRouteSchema } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  matchesRoutePattern,
  MOBILE_WEB_SHELL_GRANTS,
  grantsForRoute,
  pageRouteRefusalVerdict,
  routePatternRefusal,
  routeViewOf
} from './page-route-policy'
import { BridgePageRouteGrantsSchema } from './bridge/bridge-page-route-grants'
import { MobileWebBundleManifestReadSchema } from '../transport/mobile-web-bundle-reply-schemas'
import { MANIFEST_WIRE } from './mobile-web-shell-session-test-fixtures'
import { BRIDGE_EXTERNAL_NAVIGATION_GRANT } from './cancelled-navigation-target'
import { BRIDGE_HAPTICS_GRANT } from './bridge/bridge-haptics-notify'

function servesRoute(routes: Parameters<typeof routeViewOf>[0], pathname: string): boolean {
  return routeViewOf(routes, pathname).pageRoutes.some((pattern) =>
    matchesRoutePattern(pathname, pattern)
  )
}

function pageRoutesOf(routes: Parameters<typeof routeViewOf>[0]): string[] {
  return routeViewOf(routes, '/h/host-1').pageRoutes
}

describe('matching a concrete route against a pattern', () => {
  it('matches a dynamic segment against one segment and never against a path', () => {
    expect(matchesRoutePattern('/h/host-1', '/h/[hostId]')).toBe(true)
    expect(matchesRoutePattern('/h/host-1/session/wt-1', '/h/[hostId]')).toBe(false)
    expect(matchesRoutePattern('/h', '/h/[hostId]')).toBe(false)
  })

  it('refuses an empty dynamic segment, which is a path with a hole in it', () => {
    expect(matchesRoutePattern('/h/', '/h/[hostId]')).toBe(false)
  })

  it('matches a static segment exactly, case and all', () => {
    expect(matchesRoutePattern('/h/host-1/tasks', '/h/[hostId]/tasks')).toBe(true)
    expect(matchesRoutePattern('/h/host-1/Tasks', '/h/[hostId]/tasks')).toBe(false)
    expect(matchesRoutePattern('/h/host-1/accounts', '/h/[hostId]/tasks')).toBe(false)
  })

  it('matches a pattern with several dynamic segments', () => {
    expect(matchesRoutePattern('/h/a/session/b', '/h/[hostId]/session/[worktreeId]')).toBe(true)
    expect(matchesRoutePattern('/h/a/session', '/h/[hostId]/session/[worktreeId]')).toBe(false)
  })
})

// Accept trailing rest patterns from future desktops so already-installed shells can serve new catch-all screens.
describe('a pattern with a rest segment', () => {
  const PATTERN = '/h/[hostId]/[...page]'

  it('matches one segment and as many as follow it', () => {
    expect(matchesRoutePattern('/h/a/x', PATTERN)).toBe(true)
    expect(matchesRoutePattern('/h/a/x/y', PATTERN)).toBe(true)
    expect(matchesRoutePattern('/h/a/x/y/z', PATTERN)).toBe(true)
  })

  // Expo Router 55.0.18 formats rest as ((.*\/)) after adding a trailing slash; the tail needs its own slash, so zero segments cannot match.
  it('does not match the prefix it sits on, which is a different screen', () => {
    expect(matchesRoutePattern('/h/a', PATTERN)).toBe(false)
    expect(matchesRoutePattern('/h/a/', PATTERN)).toBe(false)
  })

  it('still holds the segments in front of it to the rule they had', () => {
    expect(matchesRoutePattern('/g/a/x', PATTERN)).toBe(false)
    expect(matchesRoutePattern('/h//x', PATTERN)).toBe(false)
    expect(matchesRoutePattern('/h/a/x', '/h/[hostId]/files/[...page]')).toBe(false)
    expect(matchesRoutePattern('/h/a/files/x/y', '/h/[hostId]/files/[...page]')).toBe(true)
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

  it('reads an ordinary pattern with nothing to refuse', () => {
    for (const pattern of ['/h/[hostId]', '/h/[hostId]/session/[worktreeId]', PATTERN]) {
      expect(routePatternRefusal(pattern), pattern).toBe(null)
    }
  })

  it('is a pathname the manifest contract already accepts, so no field has to change', () => {
    expect(
      MobileWebBundleRouteSchema.safeParse({ pathname: PATTERN, grants: ['navigate'] }).success
    ).toBe(true)
  })

  it('serves such a route and grants it what it declared', () => {
    const routes = [{ pathname: PATTERN, grants: ['navigate', 'storage'] }]
    expect(servesRoute(routes, '/h/a/insights/deep/er')).toBe(true)
    expect(grantsForRoute(routes, '/h/a/insights/deep/er')).toEqual(['navigate', 'storage'])
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

describe('the routes this shell will render from the page', () => {
  it('keeps a route whose grants it implements', () => {
    expect(pageRoutesOf([{ pathname: '/h/[hostId]', grants: ['navigate'] }])).toEqual([
      '/h/[hostId]'
    ])
    expect(pageRoutesOf([{ pathname: '/h/[hostId]', grants: [] }])).toEqual(['/h/[hostId]'])
  })

  it('drops a route needing a grant this app has never heard of', () => {
    expect(
      pageRoutesOf([
        { pathname: '/h/[hostId]', grants: ['navigate', 'teleport'] },
        { pathname: '/h/[hostId]/tasks', grants: ['navigate'] }
      ])
    ).toEqual(['/h/[hostId]/tasks'])
  })

  it('answers nothing for a desktop older than the field', () => {
    expect(pageRoutesOf(undefined)).toEqual([])
    expect(servesRoute(undefined, '/h/host-1')).toBe(false)
  })

  it('answers the two halves of the negotiation together', () => {
    const routes = [{ pathname: '/h/[hostId]', grants: ['navigate'] }]
    expect(servesRoute(routes, '/h/host-1')).toBe(true)
    expect(servesRoute(routes, '/h/host-1/tasks')).toBe(false)
    expect(servesRoute([], '/h/host-1')).toBe(false)
  })
})

describe('the grants this app implements', () => {
  // Check advertised grants against the host’s actual manifest schema; an invalid token rejects the entire bundle, not just one route.
  it('names only grants a manifest route may actually carry', () => {
    for (const grant of MOBILE_WEB_SHELL_GRANTS) {
      expect(
        MobileWebBundleRouteSchema.safeParse({ pathname: '/h/[hostId]', grants: [grant] }).success,
        grant
      ).toBe(true)
    }
  })

  it('refuses a dotted capability token that is not a native verb name', () => {
    expect(
      MobileWebBundleRouteSchema.safeParse({
        pathname: '/h/[hostId]',
        grants: ['native.externalNavigation']
      }).success
    ).toBe(false)
  })

  it('serves a route that needs the screencast lane', () => {
    expect(
      pageRoutesOf([
        { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate', 'screencastBinary'] }
      ])
    ).toEqual(['/h/[hostId]/session/[worktreeId]'])
  })

  // Narrow declared grants before init so unimplemented and ungranted both reach host enforcement as absent.
  it('drops a grant the route declared and this shell does not implement', () => {
    const routes = [
      { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate', 'aGrantFromTheFuture'] }
    ]
    expect(grantsForRoute(routes, '/h/host-1/session/wt-1')).toEqual(['navigate'])
    expect(pageRoutesOf(routes)).toEqual([])
  })

  // Keep externalNavigation optional: previews remain complete without links, so older shells should hide links instead of losing the whole screen (ruling 37.2).
  it('grants external navigation to a route that declares it optionally', () => {
    const routes = [
      {
        pathname: '/h/[hostId]/session/[worktreeId]',
        grants: ['navigate', 'storage'],
        optionalGrants: [BRIDGE_EXTERNAL_NAVIGATION_GRANT]
      }
    ]
    expect(grantsForRoute(routes, '/h/host-1/session/wt-1')).toEqual([
      'navigate',
      'storage',
      BRIDGE_EXTERNAL_NAVIGATION_GRANT
    ])
    expect(pageRoutesOf(routes)).toEqual(['/h/[hostId]/session/[worktreeId]'])
  })

  it('resolves the screencast lane for a route that declares it', () => {
    expect(
      grantsForRoute(
        [
          { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate', 'screencastBinary'] }
        ],
        '/h/host-1/session/wt-1'
      )
    ).toEqual(['navigate', 'screencastBinary'])
  })
})

describe('the native verbs this app serves', () => {
  it('names them so a route can declare one, which is what keeps that route native without it', () => {
    expect(
      pageRoutesOf([
        { pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.clipboard.write'] }
      ])
    ).toEqual(['/h/[hostId]/tasks'])
    expect(
      pageRoutesOf([
        { pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.dictation.start'] }
      ])
    ).toEqual([])
  })
})

// Unknown grant names must parse, then required ones leave their route native; rejecting the manifest would break unrelated routes on older phones.
describe('a grant name this build has never heard of', () => {
  it('leaves that route native rather than refusing the bundle', () => {
    expect(
      pageRoutesOf([
        { pathname: '/h/[hostId]', grants: ['navigate'] },
        { pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.dictation.start'] }
      ])
    ).toEqual(['/h/[hostId]'])
  })

  it('grants nothing from it either, so a route it names is served none of it', () => {
    expect(
      grantsForRoute(
        [{ pathname: '/h/[hostId]', grants: ['navigate', 'native.dictation.start'] }],
        '/h/host-1'
      )
    ).toEqual(['navigate'])
  })

  it('carries a verb the build does implement all the way to the session grants', () => {
    expect(
      grantsForRoute(
        [{ pathname: '/h/[hostId]/tasks', grants: ['navigate', 'native.clipboard.write'] }],
        '/h/host-1/tasks'
      )
    ).toEqual(['navigate', 'native.clipboard.write'])
  })
})

// One missing required token takes its entire route native; every route declaring haptics therefore depends on shell haptics support.
describe('a page route that needs the haptics token', () => {
  const route = {
    pathname: '/h/[hostId]',
    grants: ['navigate', 'storage', BRIDGE_HAPTICS_GRANT]
  }

  it('is served by this shell, which implements the token', () => {
    expect(pageRoutesOf([route])).toEqual(['/h/[hostId]'])
  })

  it('refuses an unknown required token and serves the route without it', () => {
    const unknownToken = {
      ...route,
      grants: route.grants.map((grant) =>
        grant === BRIDGE_HAPTICS_GRANT ? 'hapticsUnderAnotherName' : grant
      )
    }
    expect(pageRoutesOf([unknownToken])).toEqual([])
    expect(
      pageRoutesOf([
        { ...route, grants: route.grants.filter((grant) => grant !== BRIDGE_HAPTICS_GRANT) }
      ])
    ).toEqual(['/h/[hostId]'])
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

  it('publishes only the two members that cross, whatever else the entry carried', () => {
    const routes = MobileWebBundleManifestReadSchema.parse({
      ...MANIFEST_WIRE,
      routes: carryingAnUnreadField
    }).routes
    expect(routes?.[0]).toMatchObject({
      optionalGrants: ['screencastBinary'],
      renderer: 'someLaterDesktopsField'
    })
    expect(routeViewOf(routes, '/h/host-1').pageRouteGrants).toEqual([
      { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'screencastBinary'] }
    ])
  })

  it('publishes pairs the host schema accepts, so the session is not refused with them', () => {
    const routes = MobileWebBundleManifestReadSchema.parse({
      ...MANIFEST_WIRE,
      routes: carryingAnUnreadField
    }).routes
    expect(BridgePageRouteGrantsSchema.safeParse(routes).success).toBe(false)
    const { pageRouteGrants } = routeViewOf(routes, '/h/host-1')
    const parsed = BridgePageRouteGrantsSchema.safeParse(pageRouteGrants)
    expect(parsed.error?.issues[0]?.message ?? 'accepted').toBe('accepted')
    expect(parsed.success).toBe(true)
  })

  it('copies the list, so nothing the shell keeps is reachable through the frame it hands out', () => {
    const routes = [{ pathname: '/h/[hostId]', grants: ['navigate'] }]
    expect(routeViewOf(routes, '/h/host-1').pageRouteGrants[0]?.grants).not.toBe(routes[0]?.grants)
  })
})

describe('a route that declares an optional grant', () => {
  const pathname = '/h/[hostId]/session/[worktreeId]'
  const opened = '/h/host-1/session/wt-1'
  const declared = [
    { pathname, grants: ['navigate', 'storage'], optionalGrants: ['screencastBinary'] }
  ]

  it('is served on its required list alone, which is what decides the route', () => {
    expect(pageRoutesOf(declared)).toEqual([pathname])
    expect(pageRoutesOf([{ ...declared[0], grants: ['navigate', 'aGrantFromTheFuture'] }])).toEqual(
      []
    )
  })

  it('drops an optional name this shell does not implement, and serves the route anyway', () => {
    const fromTheFuture = [
      { pathname, grants: ['navigate', 'storage'], optionalGrants: ['aGrantFromTheFuture'] }
    ]
    expect(grantsForRoute(fromTheFuture, opened)).toEqual(['navigate', 'storage'])
    // Missing optional grants hide an affordance; missing required grants leave the screen native.
    expect(pageRoutesOf(fromTheFuture)).toEqual([pathname])
  })

  // Compute session and target-pair grants identically so local hops cannot retain targets requiring capabilities absent from their session.
  it('publishes the same list to the page as it grants the session', () => {
    const parsed = MobileWebBundleRouteSchema.parse(declared[0])
    expect(parsed.optionalGrants).toEqual(['screencastBinary'])
    const view = routeViewOf([parsed], opened)
    expect(view.pageRouteGrants).toEqual([{ pathname, grants: view.routeGrants }])
    expect(view.routeGrants).toEqual(['navigate', 'storage', 'screencastBinary'])
  })
})

describe('why the page does not serve a route', () => {
  const reasonFor = (...args: Parameters<typeof pageRouteRefusalVerdict>) =>
    pageRouteRefusalVerdict(...args)?.reason

  it('blames the desktop on a wide layout when its page cannot own the host area', () => {
    const routes = [{ pathname: '/h/[hostId]', grants: [] }]
    expect(reasonFor(routes, '/h/a', true)).toBe('page-route-unlisted')
    expect(
      reasonFor([{ ...routes[0]!, grants: ['teleport'], canOwnHostArea: true }], '/h/a', true)
    ).toBe('page-route-grant-missing')
  })
})
