import type { Event, WebContents } from 'electron'
import type { BrowserRoutePageGuestIdentity } from './browser-route-page-authority'

export type BrowserRouteGuestState = {
  guest: WebContents
  partition: string
  registration: BrowserRoutePageGuestIdentity | null
  pageAuthority: symbol | null
  navigationGranted: boolean
  retirementRequested: boolean
  retirementCallback: (() => void) | null
  onNavigate: (event: Event, url: string) => void
  onRenderProcessGone: () => void
  onDestroyed: () => void
}
