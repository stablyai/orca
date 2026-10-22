import type {
  CachedGeneration,
  MobileWebShellBlockedVerdict,
  MobileWebShellSession,
  MobileWebShellSessionState,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
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
  patch: Partial<MobileWebShellSession> = {}
): MobileWebShellStep {
  return step(session, { ...patch, state: { kind: 'activating', source: 'cache' } }, [
    {
      kind: 'open-generation',
      directory: generation.directory,
      buildId: generation.buildId,
      totalBytes: generation.totalBytes
    }
  ])
}

/**
 * Opens a generation already on disk under its own route list, or answers `unclaimed` when that list
 * does not carry it. The only judge available when the newer manifest is absent or refused:
 * opening under a bundle this shell is not running would grant the page what other bytes declared.
 *
 * `unclaimed` is the caller's because these bytes say nothing about what the host serves now: the
 * screen the newer manifest would have answered with, never a version wall. `wall` is asked only on
 * the served branch, since it judges bytes that are about to be shown. `patch` belongs to either
 * answer; `served` is what only an opened page gets.
 */
export function openByOwnRoutes(
  session: MobileWebShellSession,
  generation: CachedGeneration,
  options: {
    unclaimed: MobileWebShellSessionState
    patch?: Partial<MobileWebShellSession>
    served?: Partial<MobileWebShellSession>
    wall?: MobileWebShellBlockedVerdict | null
  }
): MobileWebShellStep {
  const { unclaimed, patch = {}, served = {}, wall = null } = options
  const view = {
    ...routeViewOf(generation.routes, session.routePathname, session.wide),
    routes: generation.routes
  }
  if (!rendersRoute(view.pageRoutes, session.routePathname)) {
    return step(session, { ...patch, ...view, state: unclaimed })
  }
  if (wall !== null) {
    return step(session, { ...patch, ...view, state: { kind: 'wall', verdict: wall } })
  }
  return openCached(session, generation, { ...patch, ...served, ...view })
}
