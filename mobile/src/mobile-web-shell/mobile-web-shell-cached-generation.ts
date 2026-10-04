import type {
  CachedGeneration,
  MobileWebShellBlockedVerdict,
  MobileWebShellSession,
  MobileWebShellSessionEffect,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import { NATIVE_ROUTE } from './mobile-web-shell-gates'
import { matchesRoutePattern, routeViewOf } from './page-route-policy'
import { step } from './mobile-web-shell-session-step'

/**
 * Putting a generation that is already on disk on screen, and deciding whether this route is one
 * that bundle carries. The only judge available when a newer manifest is absent or refused, so it
 * is the reducer's cache path and its refused-update path both.
 */

export function rendersRoute(pageRoutes: readonly string[], pathname: string): boolean {
  return pageRoutes.some((pattern) => matchesRoutePattern(pathname, pattern))
}

export function openCached(
  session: MobileWebShellSession,
  generation: CachedGeneration,
  patch: Partial<MobileWebShellSession> = {},
  andThen: readonly MobileWebShellSessionEffect[] = []
): MobileWebShellStep {
  return step(session, { ...patch, state: { kind: 'activating', source: 'cache' } }, [
    {
      kind: 'open-generation',
      directory: generation.directory,
      buildId: generation.buildId,
      totalBytes: generation.totalBytes
    },
    ...andThen
  ])
}

/**
 * Opens a generation already on disk under its own route list, or leaves the route native when that
 * list does not carry it. The only judge available when the newer manifest is absent or refused:
 * opening under a bundle this shell is not running would grant the page what other bytes declared.
 *
 * The route question comes first and `wall` is asked only on the served branch, the order
 * `onManifestRead` takes: a route this bundle never claimed is not a screen to refuse, and a
 * generation cached before routes were listed claims none at all. `patch` belongs to either answer;
 * `served` is what only an opened page gets, so the native one carries no notice about an update
 * for a screen it is not showing.
 */
export function openByOwnRoutes(
  session: MobileWebShellSession,
  generation: CachedGeneration,
  options: {
    patch?: Partial<MobileWebShellSession>
    served?: Partial<MobileWebShellSession>
    wall?: MobileWebShellBlockedVerdict | null
  } = {}
): MobileWebShellStep {
  const { patch = {}, served = {}, wall = null } = options
  const view = routeViewOf(generation.routes, session.routePathname)
  if (!rendersRoute(view.pageRoutes, session.routePathname)) {
    return step(session, { ...patch, ...view, state: NATIVE_ROUTE })
  }
  if (wall !== null) {
    return step(session, { ...patch, ...view, state: { kind: 'wall', verdict: wall } })
  }
  return openCached(session, generation, { ...patch, ...served, ...view })
}
