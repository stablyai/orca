/**
 * The route module behind each declared page route, which is what a closure is read from.
 *
 * `MOBILE_WEB_PAGE_ROUTES` names URL patterns and the bundler walks files, so something has to
 * join the two. Shared rather than restated in each census for the reason
 * `mobile-web-app-external-link-seam.mjs` is: a second copy is a list that stops growing when the
 * first one does, and every census over it goes quietly green on a route nobody added.
 *
 * Extensionless is deliberate on neither side: the `.tsx` is named because that is the file on
 * disk, and the builder's own `resolveExtensions` picks the `.web.tsx` sibling ahead of it exactly
 * as it would for the page.
 *
 * `pageRouteModulesCoverTheManifest` is the guard that holds this map to the manifest; every
 * census that reads it asserts that too, so a route registered without a row here is a route no
 * closure census reads.
 */
export const PAGE_ROUTE_MODULES = new Map([
  ['/h/[hostId]', 'app/h/[hostId]/index.tsx'],
  ['/h/[hostId]/agent-history/[worktreeId]', 'app/h/[hostId]/agent-history/[worktreeId].tsx'],
  ['/h/[hostId]/tasks', 'app/h/[hostId]/tasks.tsx'],
  ['/h/[hostId]/files/[worktreeId]', 'app/h/[hostId]/files/[worktreeId].tsx'],
  ['/h/[hostId]/files/preview/[worktreeId]', 'app/h/[hostId]/files/preview/[worktreeId].tsx'],
  ['/h/[hostId]/source-control/[worktreeId]', 'app/h/[hostId]/source-control/[worktreeId].tsx'],
  ['/h/[hostId]/review/[worktreeId]', 'app/h/[hostId]/review/[worktreeId].tsx'],
  ['/h/[hostId]/session/[worktreeId]', 'app/h/[hostId]/session/[worktreeId].tsx']
])

/** The map's pathnames and the manifest's, each sorted, for a caller to compare. */
export function pageRouteModulesCoverTheManifest(routes) {
  return {
    mapped: [...PAGE_ROUTE_MODULES.keys()].sort(),
    declared: routes.map((route) => route.pathname).sort()
  }
}
