import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type {
  BrowserClientPageNetworkRoute,
  BrowserClientPageRenderer
} from './browser-client-page-cleanup'
import type {
  BrowserRouteGuestLifecycleClaim,
  BrowserRoutePageGuestIdentity
} from './browser-route-page-authority'
import type { BrowserRouteSessionHandle } from './browser-route-session-state'
import type { BrowserRouteWebContentsRegistry } from './browser-route-webcontents-registry'

export type BrowserClientPageLifecycleRegistry = Pick<
  BrowserRouteWebContentsRegistry,
  | 'claimGuestLifecycle'
  | 'registerGuest'
  | 'grantNavigation'
  | 'revokeNavigation'
  | 'navigateGuest'
  | 'beginGuestRetirement'
> &
  Partial<Pick<BrowserRouteWebContentsRegistry, 'rekeyGuestLifecycle'>> &
  Partial<Pick<BrowserRouteWebContentsRegistry, 'grantReconciledNavigation'>>

export type BrowserClientRetainedPage = {
  generation: number
  inventory: BrowserClientHostedPageInventory
  registration: BrowserRoutePageGuestIdentity
  lifecycleClaim: BrowserRouteGuestLifecycleClaim
  renderer: BrowserClientPageRenderer
  route: BrowserClientPageNetworkRoute
  routeSession: BrowserRouteSessionHandle
  retiring: Promise<void> | null
  reconciling: boolean
}
