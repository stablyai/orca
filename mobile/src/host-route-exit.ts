type HostRouteExitRouter = {
  replace: (href: '/') => void
}

export function leaveHostRoute(router: HostRouteExitRouter): void {
  // Why: direct pairing can open /h/:hostId as the root route, and split-view
  // detail history is not the host/home screen the header is meant to exit to.
  router.replace('/')
}
