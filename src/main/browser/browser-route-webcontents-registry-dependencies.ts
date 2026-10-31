import type { Session } from 'electron'
import type {
  BrowserRoutePageAuthority,
  BrowserRoutePageOwnerIdentity
} from './browser-route-page-authority'
import type { BrowserRouteSessionRekey } from './browser-route-session-state'

export type BrowserRouteWebContentsRegistryDependencies = {
  getPartitionForSession(session: Session): string | null
  getPreparedPageAuthority(input: BrowserRoutePageOwnerIdentity): symbol | null
  rekeyPreparedPage?(
    previous: BrowserRoutePageAuthority,
    next: BrowserRoutePageOwnerIdentity
  ): BrowserRouteSessionRekey | null
  retirePreparedPage(input: BrowserRoutePageAuthority): boolean
  retirePreparedPagesOwnedByRenderer(rendererWebContentsId: number): number
  /** Route-guest popup denials need an explicit notice on the owning page. */
  reportBlockedPopup?(input: { openerWebContentsId: number; url: string }): void
  maxGuests?: number
}
