type HostRouteExitRouter = {
  dismissTo: (href: '/') => void
}

export function leaveHostRoute(router: HostRouteExitRouter): void {
  // Why: direct pairing can open /h/:hostId as the root route, and split-view detail history is
  // not the host/home screen the header is meant to exit to. dismissTo pops to home when it is on
  // the stack, so the chevron animates back like swipe-back, and replaces when it is not.
  router.dismissTo('/')
}
