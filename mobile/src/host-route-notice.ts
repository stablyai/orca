import { translate } from './i18n/mobile-i18n'

// Carry the notice with navigation because the bouncing session screen unmounts before a toast can survive.

export const HOST_ROUTE_NOTICES = {
  'worktree-missing': 'That workspace no longer exists on this host.'
} as const

export type HostRouteNotice = keyof typeof HOST_ROUTE_NOTICES

export function hostRouteNoticeMessage(notice: string | undefined): string | null {
  // URL params may name prototype keys such as toString; require an own key before returning banner text.
  if (!notice || !Object.hasOwn(HOST_ROUTE_NOTICES, notice)) {
    return null
  }
  return HOST_ROUTE_NOTICES[notice as HostRouteNotice]
}

export function hostRouteWithNotice(hostId: string, notice: HostRouteNotice): string {
  return `/h/${encodeURIComponent(hostId)}?notice=${notice}`
}

// Suppress the duplicate tablet-sidebar banner; key dismissal by code so a different later notice still appears.
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

/** The shared update notice's toast line for a server the computer updates, so it has no phone action. */
export function serverUpdateNeededNotice(serverLabel: string): string {
  return translate('host.updateNotice.toast', 'Needs a newer Orca on {{host}}', {
    host: serverLabel
  })
}
