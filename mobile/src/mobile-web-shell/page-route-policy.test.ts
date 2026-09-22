import { describe, expect, it } from 'vitest'
import { MobileWebBundleRouteSchema } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  matchesRoutePattern,
  pageRendersRoute,
  MOBILE_WEB_SHELL_GRANTS,
  grantsForRoute,
  routeViewOf
} from './page-route-policy'
import { BRIDGE_HAPTICS_GRANT } from './bridge/bridge-haptics-notify'
import {
  BRIDGE_NATIVE_METHOD_PREFIX,
  BRIDGE_NATIVE_VERB_NAMES,
  BRIDGE_NATIVE_VERBS
} from './bridge/bridge-native-verbs'

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
    expect(pageRendersRoute(undefined, '/h/host-1')).toBe(false)
  })

  it('answers the two halves of the negotiation together', () => {
    const routes = [{ pathname: '/h/[hostId]', grants: ['navigate'] }]
    expect(pageRendersRoute(routes, '/h/host-1')).toBe(true)
    expect(pageRendersRoute(routes, '/h/host-1/tasks')).toBe(false)
    expect(pageRendersRoute([], '/h/host-1')).toBe(false)
  })
})

describe('the grants this app implements', () => {
  it('names exactly what the shell honours over the bridge', () => {
    // The same list `init.grants.native` gives the page. A name here with nothing behind it is a
    // route the desktop will hand over and the page will find it cannot use.
    expect([...MOBILE_WEB_SHELL_GRANTS]).toEqual([
      'navigate',
      'storage',
      'externalLink',
      'screencastBinary',
      'haptics',
      'native.clipboard.write',
      'native.clipboard.read',
      'native.media.pick',
      'native.media.read',
      'native.media.release',
      'native.audio.start',
      'native.audio.read',
      'native.audio.stop'
    ])
  })

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

  it('names every verb in the table there too, so the two lists cannot drift apart', () => {
    // The grant list spreads the verb tuple today. Read both anyway: the spread is what makes them
    // agree, and a build that stopped spreading would leave this the only thing that noticed.
    expect(
      MobileWebBundleRouteSchema.safeParse({
        pathname: '/h/[hostId]',
        grants: [...BRIDGE_NATIVE_VERB_NAMES]
      }).success
    ).toBe(true)
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

/**
 * A verb cannot be advertised without a handler, or handled without being advertised.
 *
 * The table is keyed on the same tuple this list spreads, so a missing row does not compile. This
 * is the other direction: a name reaching `init.grants.native` that the table has never heard of,
 * which a page would then be told it may call.
 */
describe('the native verbs this app serves', () => {
  it('advertises exactly the verbs the table holds', () => {
    const advertised = MOBILE_WEB_SHELL_GRANTS.filter((grant) =>
      grant.startsWith(BRIDGE_NATIVE_METHOD_PREFIX)
    )
    expect([...advertised].sort()).toEqual([...BRIDGE_NATIVE_VERB_NAMES].sort())
    expect(Object.keys(BRIDGE_NATIVE_VERBS).sort()).toEqual([...BRIDGE_NATIVE_VERB_NAMES].sort())
  })

  it('names them so a route can declare one, which is what keeps that route native without it', () => {
    // A bundle listing a route that needs the clipboard, against a shell too old to serve it.
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
 * What an old phone does with a grant name it has never heard of.
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
 * token; the route list itself is pinned in `config/scripts/mobile-web-app-haptics-seam.test.mjs`,
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

  it('renders natively against a shell whose grant list does not carry it', () => {
    // An older shell's view of the same declaration: a grant it does not implement, whatever it is
    // spelled. Nothing degrades — the route goes native whole, pins and sidebar and all.
    const older = {
      ...route,
      grants: route.grants.map((grant) =>
        grant === BRIDGE_HAPTICS_GRANT ? 'hapticsUnderAnotherName' : grant
      )
    }
    expect(pageRoutesOf([older])).toEqual([])
    // The control, so the empty list above is the token and not the other two grants.
    expect(
      pageRoutesOf([
        { ...route, grants: route.grants.filter((grant) => grant !== BRIDGE_HAPTICS_GRANT) }
      ])
    ).toEqual(['/h/[hostId]'])
  })
})
