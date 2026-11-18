type HostRouteExitRouter = {
  dismissTo: (href: '/') => void
}

export function leaveHostRoute(router: HostRouteExitRouter): void {
  // Direct pairing may make the host route the root; dismissTo pops home when present or replaces after a cold entry, avoiding split-view detail history.
  router.dismissTo('/')
}
