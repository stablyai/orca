import { hostStackHostRoute } from './navigation/host-stack-navigation'

type HostRouteExitRouter = {
  dismissTo: (href: '/') => void
}

type HostRouteSwitchRouter = HostRouteExitRouter & {
  push: (href: `/h/${string}`) => void
}

export function leaveHostRoute(router: HostRouteExitRouter): void {
  // Direct pairing may make the host route the root; dismissTo pops home when present or replaces after a cold entry, avoiding split-view detail history.
  router.dismissTo('/')
}

// Home → host, so Back from the new desktop returns home rather than to the previous one.
export function switchHostRoute(router: HostRouteSwitchRouter, hostId: string): void {
  leaveHostRoute(router)
  router.push(hostStackHostRoute(hostId))
}
