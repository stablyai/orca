import { areWorktreePathsEqual } from '../../git/worktrees/catalog/worktree-path-comparison'

/** Where a registered repo's Git runs right now: its path and project-runtime cache key. */
export type WorktreeCatalogRoute = Readonly<{ repoPath: string; runtimeKey: string }>

type RouteResolver = (repoId: string, hostId: string) => WorktreeCatalogRoute | null

let resolveLiveRoute: RouteResolver | null = null

/** The live registration decides which route is authoritative, never whichever request arrives last. */
export function setWorktreeCatalogRouteResolver(resolver: RouteResolver | null): void {
  resolveLiveRoute = resolver
}

/** Without a registered store every request is taken as live (isolated unit callers). */
export function isLiveWorktreeCatalogRoute(
  repoId: string,
  hostId: string,
  route: WorktreeCatalogRoute
): boolean {
  if (!resolveLiveRoute) {
    return true
  }
  const live = resolveLiveRoute(repoId, hostId)
  return (
    live !== null &&
    live.runtimeKey === route.runtimeKey &&
    areWorktreePathsEqual(live.repoPath, route.repoPath)
  )
}
