import { hostStackHostRoute, type HostStackHostRoute } from './host-stack-navigation'
import { isHostRouteOf } from '../mobile-web-shell/page-route-policy'

/** Pressable's platform long-press. */
export const SESSION_LIST_LONG_PRESS_MS = 500

export type SessionListBackGesture = 'tap' | 'longPress'

// The host index is the session list #36956 and the edge swipe already land on.
export function hostSessionListHref(hostId: string): HostStackHostRoute {
  return hostStackHostRoute(hostId)
}

export function isOnHostSessionList(pathname: string, hostId: string): boolean {
  return isHostRouteOf(pathname, hostId)
}

/**
 * Long-press from any deeper route resolves to that host's session list.
 * A tap keeps the one-step target. No host, or already on the list, does not navigate.
 */
export function sessionListBackTarget(args: {
  gesture: SessionListBackGesture
  hostId: string | null
  pathname: string
  oneStepHref: string
}): string | null {
  if (args.gesture === 'tap') {
    return args.oneStepHref
  }
  if (!args.hostId || isOnHostSessionList(args.pathname, args.hostId)) {
    return null
  }
  return hostSessionListHref(args.hostId)
}

type SessionListRouter = {
  dismissTo: (href: HostStackHostRoute) => void
}

// Same host exit the shell uses: dismissTo pops the list when it is under this screen, or replaces a cold entry.
export function returnToHostSessionList(router: SessionListRouter, hostId: string): void {
  router.dismissTo(hostSessionListHref(hostId))
}
