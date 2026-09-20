import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
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
  // Spread rather than restated: the verb table is keyed on this same tuple, so a verb cannot be
  // advertised without a row and a row cannot exist without being advertised.
  ...BRIDGE_NATIVE_VERB_NAMES
] as const

export type MobileWebShellGrant = (typeof MOBILE_WEB_SHELL_GRANTS)[number]

function implementsGrant(name: string): boolean {
  return MOBILE_WEB_SHELL_GRANTS.some((grant) => grant === name)
}

/**
 * Whether a concrete route is the one a pattern names.
 *
 * Segment by segment, because a dynamic segment matches one segment and never a path: `/h/[hostId]`
 * is the worktree list and `/h/a/session/b` is a different screen that starts with the same two
 * segments. A pattern segment in brackets matches any non-empty segment; everything else is exact.
 */
export function matchesRoutePattern(pathname: string, pattern: string): boolean {
  const actual = pathname.split('/')
  const expected = pattern.split('/')
  if (actual.length !== expected.length) {
    return false
  }
  return expected.every((segment, index) => {
    const value = actual[index]
    if (value === undefined) {
      return false
    }
    return segment.startsWith('[') && segment.endsWith(']') ? value.length > 0 : segment === value
  })
}

/** The patterns this shell will render from the page: listed, and needing nothing it lacks. */
export function implementedPageRoutes(routes: readonly MobileWebPageRoute[] | undefined): string[] {
  return (routes ?? [])
    .filter((route) => route.grants.every(implementsGrant))
    .map((route) => route.pathname)
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
  const declared = (routes ?? []).find((route) => matchesRoutePattern(pathname, route.pathname))
  return declared === undefined ? [] : declared.grants.filter(implementsGrant)
}
