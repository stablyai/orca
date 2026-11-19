import type { Event, WebContents } from 'electron'
import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'
import type { BrowserRouteGuestPopupController } from './browser-route-guest-popups'

export type BrowserRouteGuestState = {
  guest: WebContents
  guestAuthority: symbol
  partition: string
  registration: BrowserRoutePageGuestIdentity | null
  /** Client-local popups share the opener's lifetime and have no logical page or wire surface. */
  popups: BrowserRouteGuestPopupController | null
  isNavigationAllowed: (url: string) => boolean
  pageAuthority: symbol | null
  navigationGranted: boolean
  retirementRequested: boolean
  availabilityLossReported: boolean
  retirementCallback: (() => void) | null
  whenDestroyed: Promise<void>
  resolveDestroyed: () => void
  onNavigate: (event: Event, url: string) => void
  onRenderProcessGone: () => void
  onDestroyed: () => void
}
