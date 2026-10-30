// One route-to-module map prevents censuses drifting independently from manifest; callers assert pageRouteModulesCoverTheManifest.
// Keep explicit .tsx paths: builder resolveExtensions selects .web.tsx siblings as it does for shipped pages.
export const PAGE_ROUTE_MODULES = new Map([
  ['/h/[hostId]', 'app/h/[hostId]/index.tsx'],
  ['/h/[hostId]/agent-history/[worktreeId]', 'app/h/[hostId]/agent-history/[worktreeId].tsx'],
  ['/h/[hostId]/tasks', 'app/h/[hostId]/tasks.tsx'],
  ['/h/[hostId]/accounts', 'app/h/[hostId]/accounts.tsx'],
  ['/h/[hostId]/new-workspace', 'app/h/[hostId]/new-workspace.tsx'],
  ['/h/[hostId]/files/[worktreeId]', 'app/h/[hostId]/files/[worktreeId].tsx'],
  ['/h/[hostId]/files/preview/[worktreeId]', 'app/h/[hostId]/files/preview/[worktreeId].tsx'],
  ['/h/[hostId]/source-control/[worktreeId]', 'app/h/[hostId]/source-control/[worktreeId].tsx'],
  ['/h/[hostId]/review/[worktreeId]', 'app/h/[hostId]/review/[worktreeId].tsx'],
  ['/h/[hostId]/session/[worktreeId]', 'app/h/[hostId]/session/[worktreeId].tsx']
])

export function pageRouteModulesCoverTheManifest(routes) {
  return {
    mapped: [...PAGE_ROUTE_MODULES.keys()].sort(),
    declared: routes.map((route) => route.pathname).sort()
  }
}
