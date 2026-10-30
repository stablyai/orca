import type { MobileWebBundleManifestRead } from '../transport/mobile-web-bundle-reply-schemas'
import { BRIDGE_TERMINAL_KEY_RAIL_GRANT } from './bridge/bridge-terminal-key'
import { BRIDGE_EXTERNAL_NAVIGATION_GRANT } from './cancelled-navigation-target'
import { BRIDGE_HAPTICS_GRANT } from './bridge/bridge-haptics-notify'
import { BRIDGE_NATIVE_VERB_NAMES } from './bridge/bridge-native-verbs'
import { BRIDGE_SCREENCAST_BINARY_GRANT } from './bridge/bridge-screencast-grant'

export type MobileWebPageRoute = NonNullable<MobileWebBundleManifestRead['routes']>[number]

// Advertise only implemented capabilities; missing required grants leave the route unserved, while missing optional grants hide its affordance.
export const MOBILE_WEB_SHELL_GRANTS = [
  'navigate',
  'storage',
  'externalLink',
  BRIDGE_SCREENCAST_BINARY_GRANT,
  BRIDGE_HAPTICS_GRANT,
  // No page notify exists for cancelled browser navigation; this capability tells the page whether native can open those links externally.
  BRIDGE_EXTERNAL_NAVIGATION_GRANT,
  // The iPhone Duo key rail: the shell draws terminal keys in a side inset strip and forwards each
  // press as a frame, which only a page declaring this knows.
  BRIDGE_TERMINAL_KEY_RAIL_GRANT,
  // Spread rather than restated: the verb table is keyed on this same tuple, so a verb cannot be
  // advertised without a row and a row cannot exist without being advertised.
  ...BRIDGE_NATIVE_VERB_NAMES
] as const

export type MobileWebShellGrant = (typeof MOBILE_WEB_SHELL_GRANTS)[number]

function implementsGrant(name: string): boolean {
  return MOBILE_WEB_SHELL_GRANTS.some((grant) => grant === name)
}

function isDynamicSegment(segment: string): boolean {
  return segment.startsWith('[') && segment.endsWith(']')
}

// Match Expo Router 55.0.18: strip brackets, then recognize the leading ellipsis.
function isRestSegment(segment: string): boolean {
  return isDynamicSegment(segment) && segment.slice(1, -1).startsWith('...')
}

export const ROUTE_PATTERN_REFUSALS = ['rest-segment-not-last', 'rest-segments-repeated'] as const

export type RoutePatternRefusal = (typeof ROUTE_PATTERN_REFUSALS)[number]

// Support one trailing rest segment only; refuse non-trailing/repeated rest rather than guess, even though Expo’s internal matcher accepts some non-trailing shapes.
export function routePatternRefusal(pattern: string): RoutePatternRefusal | null {
  const segments = pattern.split('/')
  const rest = segments.flatMap((segment, index) => (isRestSegment(segment) ? [index] : []))
  if (rest.length > 1) {
    return 'rest-segments-repeated'
  }
  return rest[0] !== undefined && rest[0] !== segments.length - 1 ? 'rest-segment-not-last' : null
}

// Match dynamic segments one-for-one; trailing rest needs one or more segments, as Expo Router 55.0.18’s trailing-slash regex requires.
export function matchesRoutePattern(pathname: string, pattern: string): boolean {
  if (routePatternRefusal(pattern) !== null) {
    return false
  }
  const actual = pathname.split('/')
  const expected = pattern.split('/')
  const fixed = isRestSegment(expected[expected.length - 1] ?? '')
    ? expected.length - 1
    : expected.length
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

// Every required grant must exist; one missing capability leaves the whole route unserved.
function implementedPageRouteEntries(
  routes: readonly MobileWebPageRoute[] | undefined
): MobileWebPageRoute[] {
  return (routes ?? []).filter((route) => route.grants.every(implementsGrant))
}

// Share effective grants between session and target pairs so handoff and host enforcement agree. Optional grants affect affordances without deciding route availability.
function effectiveRouteGrants(route: MobileWebPageRoute): string[] {
  return [...route.grants, ...(route.optionalGrants ?? [])].filter(implementsGrant)
}

// Grant only the chosen route’s declared/implemented capabilities; unlisted routes get none, never the shell’s whole clipboard-capable surface.
export function grantsForRoute(
  routes: readonly MobileWebPageRoute[] | undefined,
  pathname: string
): string[] {
  const matching = (routes ?? []).filter((route) => matchesRoutePattern(pathname, route.pathname))
  // Prefer exact declarations to overlapping rest patterns so catch-all grants cannot override a screen’s own row.
  const declared =
    matching.find((route) => !route.pathname.split('/').some(isRestSegment)) ?? matching[0]
  return declared === undefined ? [] : effectiveRouteGrants(declared)
}

// Project loose manifest entries into strict pathname/grants pairs so future desktop fields cannot reject the bridge session.
// Use the same effective grants for targets and the current route so local-hop authorization cannot drift.
export function routeViewOf(
  routes: readonly MobileWebPageRoute[] | undefined,
  pathname: string,
  wide = false
) {
  const entries = implementedPageRouteEntries(routes)
  const root = hostAreaRoot(pathname)
  if (!servesWideLayout(entries, pathname, wide)) {
    return { pageRoutes: [], pageRouteGrants: [], routeGrants: [], ownsHostArea: false }
  }
  const canOwnHostArea =
    root !== null &&
    entries.some(
      (route) =>
        route.canOwnHostArea === true &&
        matchesRoutePattern(root, route.pathname) &&
        (wide || route.canOwnHostAreaAcrossLayouts === true)
    )
  // New pages keep ownership across rotation; legacy pages require the wide-only contract.
  const ownsHostArea = canOwnHostArea && pathname === root
  // No pair for the host route in an owned detail session, so a hop there goes to the shell, which
  // opens it owning the area rather than as a second host list in this pane.
  const paired =
    canOwnHostArea && !ownsHostArea && root !== null
      ? entries.filter((route) => !matchesRoutePattern(root, route.pathname))
      : entries
  return {
    pageRoutes: entries.map((route) => route.pathname),
    pageRouteGrants: paired.map((route) => ({
      pathname: route.pathname,
      grants: effectiveRouteGrants(route)
    })),
    routeGrants: ownsHostArea ? hostAreaGrants(entries) : grantsForRoute(routes, pathname),
    ownsHostArea
  }
}

type RouteViewFacts = {
  readonly pageRoutes: readonly string[]
  readonly pageRouteGrants: readonly { readonly pathname: string }[]
  readonly routeGrants: readonly string[]
  readonly ownsHostArea: boolean
}

// Compare paired route names too: wide detail sessions omit the host-route pair.
export function sameRouteView(a: RouteViewFacts, b: RouteViewFacts): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((item, index) => item === y[index])
  const paired = (view: RouteViewFacts) => view.pageRouteGrants.map((pair) => pair.pathname)
  return (
    a.ownsHostArea === b.ownsHostArea &&
    same(a.pageRoutes, b.pageRoutes) &&
    same(paired(a), paired(b)) &&
    same(a.routeGrants, b.routeGrants)
  )
}

export function isHostRouteOf(href: string, hostId: string): boolean {
  const [path] = href.split(/[?#]/)
  return path === `/h/${hostId}` || path === `/h/${encodeURIComponent(hostId)}`
}

function hostAreaRoot(pathname: string): string | null {
  const [empty, h, host] = pathname.split('/')
  return empty === '' && h === 'h' && host !== undefined && host !== '' ? `/h/${host}` : null
}

function pageCanOwnHostArea(entries: readonly MobileWebPageRoute[], root: string): boolean {
  return entries.some(
    (route) => route.canOwnHostArea === true && matchesRoutePattern(root, route.pathname)
  )
}

// Require host-area ownership support on wide layouts to prevent old pages duplicating the native sidebar.
function servesWideLayout(
  entries: readonly MobileWebPageRoute[],
  pathname: string,
  wide: boolean
): boolean {
  const root = hostAreaRoot(pathname)
  return !wide || (root !== null && pageCanOwnHostArea(entries, root))
}

// Blame missing shell grants only if implementing every grant would serve the route; unreadable patterns cannot establish which app needs updating.
export type PageRouteRefusalVerdict =
  | { readonly kind: 'blocked'; readonly reason: 'page-route-unlisted' }
  | { readonly kind: 'blocked'; readonly reason: 'page-route-grant-missing' }

export function pageRouteRefusalVerdict(
  routes: readonly MobileWebPageRoute[] | undefined,
  pathname: string,
  wide: boolean
): PageRouteRefusalVerdict | null {
  const declared = routes ?? []
  if (declared.some((route) => routePatternRefusal(route.pathname) !== null)) {
    return null
  }
  const servedWithEveryGrant =
    servesWideLayout(declared, pathname, wide) &&
    declared.some((route) => matchesRoutePattern(pathname, route.pathname))
  return {
    kind: 'blocked',
    reason: servedWithEveryGrant ? 'page-route-grant-missing' : 'page-route-unlisted'
  }
}

// Host-area pages navigate all served routes in-page and read their workspace keys, so combine effective grants plus native.storage.read.
function hostAreaGrants(entries: readonly MobileWebPageRoute[]): string[] {
  return [...new Set([...entries.flatMap(effectiveRouteGrants), 'native.storage.read'])]
}
