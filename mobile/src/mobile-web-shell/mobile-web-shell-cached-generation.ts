import type {
  CachedGeneration,
  MobileWebShellBlockedVerdict,
  MobileWebShellSession,
  MobileWebShellSessionState,
  MobileWebShellStep
} from './mobile-web-shell-session-contract'
import { matchesRoutePattern, routeViewOf } from './page-route-policy'
import { step } from './mobile-web-shell-session-step'

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

// Judge cached bytes by their own routes/grants, never a replacement manifest. Only served routes earn a compat wall; unclaimed routes use the caller’s fallback.
// Apply patch to either outcome and served only when opening the page.
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
