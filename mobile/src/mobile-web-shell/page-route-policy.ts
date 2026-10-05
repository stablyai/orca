import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import { BRIDGE_EXTERNAL_NAVIGATION_GRANT } from './cancelled-navigation-target'
import { BRIDGE_HAPTICS_GRANT } from './bridge/bridge-haptics-notify'
import { BRIDGE_NATIVE_VERB_NAMES } from './bridge/bridge-native-verbs'
import { BRIDGE_SCREENCAST_BINARY_GRANT } from './bridge/bridge-screencast-grant'

/** The manifest's route entries, as this shell reads them. */
export type MobileWebPageRoute = NonNullable<MobileWebBundleManifestRead['routes']>[number]

/**
 * What this app build does on a page's behalf.
 *
 * Every name here is a capability the shell implements and will honour over the bridge, and it is
 * the same list `init.grants.native` tells the page it has. A bundle naming a grant absent from
 * here renders its native screen instead: an old app against a new bundle lands on a screen that
 * works rather than on a tap that does nothing.
 */
export const MOBILE_WEB_SHELL_GRANTS = [
  'navigate',
  'storage',
  'externalLink',
  // The screencast's binary frames, encoded into `event.binary` for a page that subscribed with
  // `wantsBinary`. Named where the rule that reads it lives, so the two cannot drift.
  BRIDGE_SCREENCAST_BINARY_GRANT,
  // The device's own feedback, played by the app's functions on the page's behalf. A token rather
  // than the notify's dotted name, because a notify is not a verb: the dotted names below are the
  // verb table's, spread from it.
  BRIDGE_HAPTICS_GRANT,
  // A gesture-started navigation off the shell's own document, cancelled and opened outside the
  // app. Named where the rule that acts on it lives, and a third token that is neither verb nor
  // notify: the page posts nothing for it, so only this list can tell a page a tap escapes.
  BRIDGE_EXTERNAL_NAVIGATION_GRANT,
  // Spread rather than restated: the verb table is keyed on this same tuple, so a verb cannot be
  // advertised without a row and a row cannot exist without being advertised.
  ...BRIDGE_NATIVE_VERB_NAMES
] as const

export type MobileWebShellGrant = (typeof MOBILE_WEB_SHELL_GRANTS)[number]

function implementsGrant(name: string): boolean {
  return MOBILE_WEB_SHELL_GRANTS.some((grant) => grant === name)
}

/** A pattern segment expo-router would read as dynamic: `[hostId]`, and `[...page]` with it. */
function isDynamicSegment(segment: string): boolean {
  return segment.startsWith('[') && segment.endsWith(']')
}

/**
 * expo-router's rest segment, which stands for a path rather than a segment.
 *
 * Read the way `matchers.js` reads it at expo-router 55.0.18: the brackets come off and the name
 * left behind starts with `...`.
 */
function isRestSegment(segment: string): boolean {
  return isDynamicSegment(segment) && segment.slice(1, -1).startsWith('...')
}

/** Why this matcher will not read a pattern. A refused pattern matches nothing. */
export const ROUTE_PATTERN_REFUSALS = ['rest-segment-not-last', 'rest-segments-repeated'] as const

export type RoutePatternRefusal = (typeof ROUTE_PATTERN_REFUSALS)[number]

/**
 * Whether a manifest pattern is one this matcher can read, and what is wrong with it if not.
 *
 * One rest segment, trailing, is the shape expo-router's own file system can produce and the only
 * one this reads. Anything else is refused by name and matches nothing, so its route stays native
 * — the same answer a phone too old to have heard of rest segments gives, and the answer a shell
 * should give for a pattern whose tail it cannot say it understood.
 *
 * Narrower than expo-router on purpose, and the one place the two differ: its own matcher does
 * take a non-trailing rest, `h/*page/tail` matching `/h/a/b/tail` at 55.0.18. This refuses it
 * rather than copying a shape nothing produces and this shell cannot reason about.
 */
export function routePatternRefusal(pattern: string): RoutePatternRefusal | null {
  const segments = pattern.split('/')
  const rest = segments.flatMap((segment, index) => (isRestSegment(segment) ? [index] : []))
  if (rest.length > 1) {
    return 'rest-segments-repeated'
  }
  return rest[0] !== undefined && rest[0] !== segments.length - 1 ? 'rest-segment-not-last' : null
}

/**
 * Whether a concrete route is the one a pattern names.
 *
 * Segment by segment, because a dynamic segment matches one segment and never a path: `/h/[hostId]`
 * is the worktree list and `/h/a/session/b` is a different screen that starts with the same two
 * segments. A pattern segment in brackets matches any non-empty segment; everything else is exact.
 *
 * A trailing `[...page]` is the exception and matches one segment or many, never none. Nothing on
 * the desktop declares one today; a desktop that ships a catch-all screen later writes such a
 * pattern into its manifest, and a phone already in the store has to read it. One or more and not
 * zero is expo-router's own answer at 55.0.18: `getReactNavigationConfig.js` turns `[...page]` into
 * the path part `*page`, `fork/getStateFromPath-forks.js` turns that into `((.*\/))`, and
 * `cleanPath` beside it gives every path a trailing slash — so the tail must hold a slash of its
 * own, and the prefix the pattern sits on is a different screen.
 */
export function matchesRoutePattern(pathname: string, pattern: string): boolean {
  if (routePatternRefusal(pattern) !== null) {
    return false
  }
  const actual = pathname.split('/')
  const expected = pattern.split('/')
  const fixed = isRestSegment(expected[expected.length - 1] ?? '')
    ? expected.length - 1
    : expected.length
  // Exact where the pattern is all segments, and at least one tail segment where it ends in a rest.
  if (fixed === expected.length ? actual.length !== fixed : actual.length <= fixed) {
    return false
  }
  return (
    expected.slice(0, fixed).every((segment, index) => {
      const value = actual[index]
      if (value === undefined) {
        return false
      }
      return isDynamicSegment(segment) ? value.length > 0 : segment === value
    }) && actual.slice(fixed).every((value) => value.length > 0)
  )
}

/**
 * The routes this shell will render from the page: listed, and needing nothing it lacks.
 *
 * `every` and not `some`: one grant this build lacks takes the whole route native, so a token every
 * page route declares couples the whole set to a shell that carries it — `haptics` is the first,
 * and against a shell without it no page route is served at all.
 */
function implementedPageRouteEntries(
  routes: readonly MobileWebPageRoute[] | undefined
): MobileWebPageRoute[] {
  return (routes ?? []).filter((route) => route.grants.every(implementsGrant))
}

/**
 * One route's effective grants: what it declared on either lane, narrowed to what this shell does.
 *
 * The one place a session's list is computed, because it is read twice -- once for the route the
 * shell opened and once for every pattern the page is told it may keep -- and two spellings of
 * "what this route gets" is how the page's handoff rule and the host's enforcement drift apart.
 *
 * `optionalGrants` is what the screen is better with and complete without, so it joins the list a
 * session is granted without joining the list that decides whether the route is served at all. A
 * name in it this shell does not implement simply is not granted: the page reads its own
 * `init.grants.native`, finds the name absent, and hides the affordance -- the same answer it gets
 * from a shell too old to have heard of the name, which is the answer ruling 37 rests on.
 */
function effectiveRouteGrants(route: MobileWebPageRoute): string[] {
  return [...route.grants, ...(route.optionalGrants ?? [])].filter(implementsGrant)
}

/** The patterns alone, for the readers in this module that only name routes. */
function implementedPageRoutes(routes: readonly MobileWebPageRoute[] | undefined): string[] {
  return implementedPageRouteEntries(routes).map((route) => route.pathname)
}

/**
 * Whether the page renders this route, rather than the native screen.
 *
 * Both halves are the negotiation: the desktop lists what it has proved on the web, and the shell
 * answers for what it can do. Either side saying no leaves the route native, which is where every
 * route starts and what every phone already ships.
 */
export function pageRendersRoute(
  routes: readonly MobileWebPageRoute[] | undefined,
  pathname: string
): boolean {
  return implementedPageRoutes(routes).some((pattern) => matchesRoutePattern(pathname, pattern))
}

/**
 * The grants one page session gets: what this shell implements, narrowed to what the route it was
 * opened for declared.
 *
 * Narrowed, because `init.grants.native` is what the page is allowed to do, and handing every
 * session the shell's whole capability set gives a route that asked for `navigate` and `storage`
 * the clipboard as well. That was harmless while every grant was a navigation or a write the page
 * could make anyway, and stopped being harmless the moment a verb reads something back.
 *
 * A route the bundle does not declare gets nothing, which is the same answer as a page the shell
 * would not render at all.
 */
export function grantsForRoute(
  routes: readonly MobileWebPageRoute[] | undefined,
  pathname: string
): string[] {
  const matching = (routes ?? []).filter((route) => matchesRoutePattern(pathname, route.pathname))
  // A rest pattern covers every pathname under its prefix, so a desktop that declares both lands
  // two entries on one pathname. The exact one is what named this screen; taking the rest route's
  // list instead would hand a screen with its own row whatever the catch-all asked for.
  const declared =
    matching.find((route) => !route.pathname.split('/').some(isRestSegment)) ?? matching[0]
  return declared === undefined ? [] : effectiveRouteGrants(declared)
}

/**
 * What one bundle's route list says about one session, in the three shapes the reducer needs.
 *
 * Derived together because they are one reading of one list: the patterns the page may keep, what
 * each of them declared, and what this route itself was granted. Three sites used to spell this
 * out; a fourth spelling is how they drift.
 *
 * `pageRouteGrants` is built rather than passed through, and that is load-bearing. The phone reads
 * a manifest route loosely, so an entry arrives carrying whatever the desktop that wrote it knew
 * about; `BridgePageRouteGrantsSchema` is `.strict()`, so one unread key refuses the pairs, and
 * `bridge-host.ts` refuses the whole session with them. A desktop field this build has never heard
 * of must cost the page nothing, which means only the two members that cross may be handed over.
 *
 * Each pair carries the target's effective list, the same one `routeGrants` answers with, because
 * the page compares the two: `route-handoff.web.ts` keeps a hop local when the target's pair is
 * covered by what this session holds. A pair naming the required lane alone would keep a hop whose
 * target then runs without the capability it asked for, which is the drift that rule exists against.
 */
export function routeViewOf(routes: readonly MobileWebPageRoute[] | undefined, pathname: string) {
  const entries = implementedPageRouteEntries(routes)
  return {
    pageRoutes: entries.map((route) => route.pathname),
    pageRouteGrants: entries.map((route) => ({
      pathname: route.pathname,
      grants: effectiveRouteGrants(route)
    })),
    routeGrants: grantsForRoute(routes, pathname)
  }
}
