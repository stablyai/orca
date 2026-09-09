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
  /** Surfaces a denied route-guest popup on the owning page; without it denials are silent. */
  reportBlockedPopup?(input: { openerWebContentsId: number; url: string }): void
  maxGuests?: number
}
