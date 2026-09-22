import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MobileWebBundleRouteSchema } from '../../../src/shared/mobile-web-bundle/manifest-contract'
import {
  matchesRoutePattern,
  pageRendersRoute,
  MOBILE_WEB_SHELL_GRANTS,
  grantsForRoute,
  routeViewOf
} from './page-route-policy'
import { BridgePageRouteGrantsSchema } from './bridge/bridge-page-route-grants'
import { BRIDGE_EXTERNAL_NAVIGATION_GRANT } from './cancelled-navigation-target'
import { BRIDGE_HAPTICS_GRANT } from './bridge/bridge-haptics-notify'
import {
  BRIDGE_NATIVE_METHOD_PREFIX,
  BRIDGE_NATIVE_VERB_NAMES,
  BRIDGE_NATIVE_VERBS
} from './bridge/bridge-native-verbs'
import { BRIDGE_SCREENCAST_BINARY_GRANT } from './bridge/bridge-screencast-grant'

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
      'externalNavigation',
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

  /**
   * The set is the verb table plus three tokens, and nothing else.
   *
   * The verb half is spread from the table and pinned below. This is the other half: a token is a
   * shell behaviour with no request behind it, so nothing makes one appear except a line in this
   * list -- and a page reads `init.grants.native` for all of them alike. Named against the modules
   * that declare them rather than as strings, so a rename has to change both sides.
   */
  it('names exactly three behaviours that are not verbs, each from its own module', () => {
    const tokens = MOBILE_WEB_SHELL_GRANTS.filter(
      (grant) => !grant.startsWith(BRIDGE_NATIVE_METHOD_PREFIX)
    )
    expect([...tokens]).toEqual([
      'navigate',
      'storage',
      'externalLink',
      BRIDGE_SCREENCAST_BINARY_GRANT,
      BRIDGE_HAPTICS_GRANT,
      BRIDGE_EXTERNAL_NAVIGATION_GRANT
    ])
    // Not a verb spelling, and not a notify's dotted name: the grammar would refuse either.
    expect(BRIDGE_EXTERNAL_NAVIGATION_GRANT).toBe('externalNavigation')
    expect(
      MobileWebBundleRouteSchema.safeParse({
        pathname: '/h/[hostId]',
        grants: ['native.externalNavigation']
      }).success
    ).toBe(false)
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
    // And a shell without the behaviour serves the same route, granting the rest: the page reads
    // the name absent and hides the affordance, which is the whole of the hide path.
    const older = MOBILE_WEB_SHELL_GRANTS.filter(
      (grant) => grant !== BRIDGE_EXTERNAL_NAVIGATION_GRANT
    )
    expect(older).not.toContain(BRIDGE_EXTERNAL_NAVIGATION_GRANT)
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
    expect(routeViewOf(carryingAnUnreadField, '/h/host-1').pageRouteGrants).toEqual([
      { pathname: '/h/[hostId]', grants: ['navigate', 'storage', 'screencastBinary'] }
    ])
  })

  it('publishes pairs the host schema accepts, so the session is not refused with them', () => {
    const { pageRouteGrants } = routeViewOf(carryingAnUnreadField, '/h/host-1')
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

  it('grants the optional name as well, so the page can read it off its own init', () => {
    expect(grantsForRoute(declared, opened)).toEqual(['navigate', 'storage', 'screencastBinary'])
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
    const view = routeViewOf(declared, opened)
    expect(view.pageRouteGrants).toEqual([{ pathname, grants: view.routeGrants }])
    expect(view.routeGrants).toEqual(['navigate', 'storage', 'screencastBinary'])
  })
})

/**
 * Old shell, new manifest: the claim design B rests on, so it gets its own case.
 *
 * And the claim as the design stated it is false, which is why this is measured rather than
 * asserted. The design and ruling 37 say the phone's loose reader "drops the unknown field"; it does
 * not. `z.looseObject` passes unknown members through (measured on zod 4.4.3, and by the first case
 * below), so a shell older than the field holds an entry that still carries it. What such a shell
 * lacks is a policy that reads it -- so it serves the route on its required list and grants nothing
 * extra, which is the conclusion the design wanted.
 *
 * The part that does not survive is the publish: an entry carrying the field reaches the strict pair
 * schema and refuses the whole session, not one field. So what makes design B safe against a shell
 * is that shell publishing built pairs rather than forwarded entries -- ruling 37.4's fix is the
 * compatibility argument, not a tidy-up before it.
 *
 * `installedShellPolicy` is the policy half of an older shell, written as the read it makes.
 */
describe('a shell whose policy has never heard of the optional lane', () => {
  const pathname = '/h/[hostId]/session/[worktreeId]'
  const opened = '/h/host-1/session/wt-1'
  const loose = z.array(
    z.looseObject({
      pathname: z.string().min(1).max(255),
      grants: z.array(z.string().min(1).max(64))
    })
  )
  const written = [
    { pathname, grants: ['navigate', 'storage'], optionalGrants: ['screencastBinary'] }
  ]
  /** The older shell's reading of a route: its required list, narrowed, and no second lane. */
  const installedShellPolicy = (route: { grants: readonly string[] }) =>
    route.grants.filter((grant) => MOBILE_WEB_SHELL_GRANTS.some((known) => known === grant))

  it('is handed a manifest that really does carry the field', () => {
    // The presence precondition. Without it every arm below passes against a fixture that never had
    // the key, which reads the same as a reader that removed it.
    const parsed = MobileWebBundleRouteSchema.safeParse(written[0])
    expect(parsed.success && parsed.data.optionalGrants).toEqual(['screencastBinary'])
  })

  it('still holds the field after its own reader, which passes unknown members through', () => {
    const read = loose.parse(written)
    expect(Object.hasOwn(read[0] ?? {}, 'optionalGrants')).toBe(true)
  })

  it('serves the route on its required list and grants nothing extra', () => {
    const read = loose.parse(written)
    expect(pageRoutesOf(read)).toEqual([pathname])
    expect(installedShellPolicy(read[0] ?? { grants: [] })).toEqual(['navigate', 'storage'])
  })

  it('publishes pairs a strict schema takes, which is what keeps the session at all', () => {
    // The half the design missed. Forwarded entries carry the field into
    // `BridgePageRouteGrantsSchema`, which refuses them and takes the whole `init` with them;
    // `bridge-host-init.test.ts` pins that end to end.
    const pairs = routeViewOf(loose.parse(written), opened).pageRouteGrants
    expect(BridgePageRouteGrantsSchema.safeParse(pairs).success).toBe(true)
  })

  it('is the only difference from this build, which reads the field and grants it', () => {
    // The control: same manifest, this build's policy, one more grant. Without it the arms above
    // are also what a policy that ignored the lane entirely would report.
    expect(grantsForRoute(written, opened)).toEqual(['navigate', 'storage', 'screencastBinary'])
  })
})
