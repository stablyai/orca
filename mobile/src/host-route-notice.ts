// Why a route param rather than a toast: the screen that learns the bad news (the session)
// unmounts as it bounces, so the message has to travel with the navigation to survive.

export const HOST_ROUTE_NOTICES = {
  'worktree-missing': 'That workspace no longer exists on this host.'
} as const

export type HostRouteNotice = keyof typeof HOST_ROUTE_NOTICES

/** The banner text for a route param, or null when absent/unrecognized — an unknown code
 *  from a future build must render nothing rather than leak the raw param. */
export function hostRouteNoticeMessage(notice: string | undefined): string | null {
  // Why hasOwn: the param is attacker-adjacent URL text, and a plain lookup of 'toString'
  // would hand the banner a function off the prototype instead of missing.
  if (!notice || !Object.hasOwn(HOST_ROUTE_NOTICES, notice)) {
    return null
  }
  return HOST_ROUTE_NOTICES[notice as HostRouteNotice]
}

export function hostRouteWithNotice(hostId: string, notice: HostRouteNotice): string {
  return `/h/${encodeURIComponent(hostId)}?notice=${notice}`
}

/** The banner the host screen should draw, if any.
 *  `embedded` is the tablet sidebar, which shares the route with the routed screen — one
 *  bounce must not draw two banners. `dismissed` is keyed by code rather than a boolean so
 *  closing one notice cannot swallow a later, different one. */
export function visibleHostRouteNotice(
  embedded: boolean,
  notice: string | undefined,
  dismissed: string | null
): string | null {
  if (embedded || (notice && notice === dismissed)) {
    return null
  }
  return hostRouteNoticeMessage(notice)
}
