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

/** Whether a narrow session on `pathname` would be served the page under `routes`. */
function servesRoute(routes: Parameters<typeof routeViewOf>[0], pathname: string): boolean {
  return routeViewOf(routes, pathname).pageRoutes.some((pattern) =>
    matchesRoutePattern(pathname, pattern)
  )
}

/**
 * The patterns a session would be told it may keep, read through the view the reducer builds.
 *
 * The pathname is arbitrary here: `pageRoutes` is the filtered list and does not depend on which
 * route the session was opened for, which the grant cases below read separately.
 */
function pageRoutesOf(routes: Parameters<typeof routeViewOf>[0]): string[] {
  return routeViewOf(routes, '/h/host-1').pageRoutes
}

describe('matching a concrete route against a pattern', () => {
  it('matches a dynamic segment against one segment and never against a path', () => {
    expect(matchesRoutePattern('/h/host-1', '/h/[hostId]')).toBe(true)
    // The session screen starts with the same two segments and is a different screen. Matching it
    // here would open the page for a route it does not carry.
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

/**
 * A trailing rest segment, which nothing on the desktop declares today.
 *
 * Forward compatibility, which is what OTA is for: a desktop that later ships a screen under a
 * catch-all writes its pattern into the manifest, and a phone already in the store has to be able
 * to read it. Segment-count-exact matching read `[...page]` as an ordinary dynamic segment, so such
 * a pattern matched exactly one segment and nothing else.
 */
describe('a pattern with a rest segment', () => {
  const PATTERN = '/h/[hostId]/[...page]'

  it('matches one segment and as many as follow it', () => {
    expect(matchesRoutePattern('/h/a/x', PATTERN)).toBe(true)
    expect(matchesRoutePattern('/h/a/x/y', PATTERN)).toBe(true)
    expect(matchesRoutePattern('/h/a/x/y/z', PATTERN)).toBe(true)
  })

  /**
   * Zero is not a match, which is expo-router 55.0.18's own answer for the same pattern.
   *
   * `getReactNavigationConfig.js` turns `[...page]` into the path part `*page`, and
   * `fork/getStateFromPath-forks.js`'s `formatRegexPattern` turns that into `((.*\/))` — while
   * `cleanPath` in the same file gives the path a trailing slash. So the tail has to contain at
   * least one slash of its own, and `/h/a` does not reach a route whose pattern ends in `[...page]`.
   * Measured against those two functions directly at that version.
   */
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

  /**
   * One, and trailing. A rest segment elsewhere is a pattern this matcher cannot read, so it is
   * refused by name rather than guessed at: the route then stays native, which is where every
   * route starts and what a phone that never heard of the shape would also do.
   */
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

  /**
   * A rest pattern covers every pathname under its prefix, so a desktop declaring both lands two
   * entries on one pathname. The exact one named that screen; taking the rest route's grants
   * instead would hand a screen with its own row whatever the catch-all asked for.
   */
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
    // The whole point of the negotiation: a newer desktop shipping a screen that needs more than
    // this app can do leaves that one route native rather than handing it a dead tap.
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
  /**
   * Every grant this shell advertises, run through the schema a desktop parses a manifest with.
   *
   * The schema itself, not a copy of its pattern: `bundled-mobile-web-bundle.ts` parses the whole
   * manifest, so one grant name the pattern refuses is not a route that degrades to native — it is
   * a bundle the phone rejects entire. A verb this shell serves and no manifest may name is a verb
   * no route can ever be granted, which is the same as not having it.
   */
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

  /** The route C7 will declare, served by a shell that has the lane. The name's shape is the host
   *  contract's rule and is pinned there, beside the pattern that decides it. */
  it('serves a route that needs the screencast lane', () => {
    expect(
      pageRoutesOf([
        { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate', 'screencastBinary'] }
      ])
    ).toEqual(['/h/[hostId]/session/[worktreeId]'])
  })

  /**
   * The half the host cannot see, and the reason it does not have to.
   *
   * A session's list is a route's declared grants narrowed to what this shell implements, so a
   * grant the shell lacks never reaches the host at all: granted-but-unimplemented and
   * never-granted arrive there as the same absence, and the host's own rule reads one case.
   * `bridge-host-screencast.test.ts` pins what it does with it.
   */
  it('drops a grant the route declared and this shell does not implement', () => {
    const routes = [
      { pathname: '/h/[hostId]/session/[worktreeId]', grants: ['navigate', 'aGrantFromTheFuture'] }
    ]
    expect(grantsForRoute(routes, '/h/host-1/session/wt-1')).toEqual(['navigate'])
    expect(pageRoutesOf(routes)).toEqual([])
  })

  /**
   * The token C8.1 exists for, on the lane it is declared on.
   *
   * Optional, because a preview whose links are inert is still a complete screen (ruling 37.2): the
   * artifact renders, the toggle works, the source tab works. Required would have taken the whole
   * session screen native on every shell built before C7.10 A.
   */
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
    // Known clipboard and unknown dictation grants take different paths in the current policy.
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

/**
 * What this policy does with an unknown grant name.
 *
 * Widening what a manifest field may contain is a new optional value crossing to readers that
 * shipped before it. The phone's manifest schema bounds a grant's length and nothing else, on
 * purpose, so an unknown name is not a parse failure that would refuse the whole bundle — it is a
 * grant this build does not implement, and the route carrying it stays native.
 */
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

/**
 * What a token on every page route costs against a shell that does not carry it.
 *
 * The route filter behind this view is `grants.every(implementsGrant)`, so one grant this build lacks
 * takes the whole route native rather than degrading the feature that needed it. `haptics` is
 * declared by all five page routes, which makes the whole set conditional on a shell carrying the
 * token; the route list itself is pinned in `config/scripts/mobile-web-app/platform-seams/mobile-web-app-haptics-seam.test.mjs`,
 * and this is the mechanism behind it.
 */
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
    // The control, so the empty list above is the token and not the other two grants.
    expect(
      pageRoutesOf([
        { ...route, grants: route.grants.filter((grant) => grant !== BRIDGE_HAPTICS_GRANT) }
      ])
    ).toEqual(['/h/[hostId]'])
  })
})

/**
 * What the publish hands the host, against the schema the host holds it to.
 *
 * `BridgePageRouteGrantsSchema` is `.strict()` and the phone's manifest reader is loose, so these
 * two rules meet on this one value: an entry arrives carrying whatever field the desktop that wrote
 * it knew about, and a strict parse of that entry refuses the pairs and takes the session with
 * them. The route below is the shape the next desktop field has -- read by that desktop, unknown
 * here -- and the case is that it costs this page nothing.
 */
describe('the pairs a session publishes to the page', () => {
  // Two unread keys, and neither is a guess: `optionalGrants` is the field this lane added, so it
  // stands for one a shell built today reads, and `renderer` stands for the next one a desktop
  // writes and no build here has heard of. The strict pair schema refuses either.
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

/**
 * The optional lane, read off one route (ruling 37).
 *
 * `screencastBinary` stands in for the capability under test: a real token this shell implements,
 * so the cases below measure the lane and not whether a name is known.
 */
describe('a route that declares an optional grant', () => {
  const pathname = '/h/[hostId]/session/[worktreeId]'
  const opened = '/h/host-1/session/wt-1'
  const declared = [
    { pathname, grants: ['navigate', 'storage'], optionalGrants: ['screencastBinary'] }
  ]

  it('is served on its required list alone, which is what decides the route', () => {
    expect(pageRoutesOf(declared)).toEqual([pathname])
    // And the required lane still decides it: one required name this shell lacks takes it native
    // however short the optional list is.
    expect(pageRoutesOf([{ ...declared[0], grants: ['navigate', 'aGrantFromTheFuture'] }])).toEqual(
      []
    )
  })

  it('drops an optional name this shell does not implement, and serves the route anyway', () => {
    const fromTheFuture = [
      { pathname, grants: ['navigate', 'storage'], optionalGrants: ['aGrantFromTheFuture'] }
    ]
    expect(grantsForRoute(fromTheFuture, opened)).toEqual(['navigate', 'storage'])
    // The difference from the required lane, in one place: unimplemented-and-optional is a hidden
    // affordance, unimplemented-and-required is a native screen.
    expect(pageRoutesOf(fromTheFuture)).toEqual([pathname])
  })

  /**
   * One object for the measure and the measured.
   *
   * `routeGrants` is what the session is granted and each pair is what the page compares a hop
   * against. Two spellings of "what this route gets" is how `route-handoff.web.ts` comes to keep a
   * hop whose target then runs without the capability it asked for, so they are one computation and
   * this is the case that says so.
   */
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
