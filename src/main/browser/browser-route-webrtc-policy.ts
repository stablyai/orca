import type { WebContents } from 'electron'
import { closeRouteGuest, isRouteGuestDestroyed } from './browser-route-guest-guard'

export function enforceBrowserRouteWebRtcPolicy(
  guest: WebContents,
  onGuestClosed: () => void
): boolean {
  try {
    guest.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    return true
  } catch {
    closeRouteGuest(guest)
    if (isRouteGuestDestroyed(guest)) {
      onGuestClosed()
    }
    return false
  }
}
