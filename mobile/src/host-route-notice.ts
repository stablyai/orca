// Why a route param rather than a toast: the screen that learns the bad news (the session)
// unmounts as it bounces, so the message has to travel with the navigation to survive.
import { t } from '@/i18n/mobile-i18n'

export type HostRouteNotice = 'worktree-missing'

function isHostRouteNotice(notice: string): notice is HostRouteNotice {
  return notice === 'worktree-missing'
}

/** The banner text for a route param, or null when absent/unrecognized — an unknown code
 *  from a future build must render nothing rather than leak the raw param. */
export function hostRouteNoticeMessage(notice: string | undefined): string | null {
  // Why exact match: this is attacker-adjacent URL text and unknown codes must stay silent.
  if (!notice || !isHostRouteNotice(notice)) {
    return null
  }
  return t('hostRouteNotice.worktreeMissing')
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
