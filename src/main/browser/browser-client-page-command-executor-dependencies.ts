import type { BrowserClientAutomationMethod } from '../../shared/browser-client-automation-protocol'
import type { BrowserClientFileChannelTransport } from './browser-client-file-channel-transport'
import type { BrowserClientPageGuestBinding } from './browser-client-page-guest-binding'
import type { BrowserClientUploadStaging } from './browser-client-upload-staging'
import type {
  BrowserClientPageNetworkRoute,
  BrowserClientPageRenderer
} from './browser-client-page-cleanup'
import type { BrowserRouteSessionRegistry } from './browser-route-session-registry'
import type {
  BrowserClientPageLifecycleRegistry,
  BrowserClientRetainedPage
} from './browser-client-page-retained-state'

/**
 * Storage identity of the connection a page's partition is derived from.
 *
 * The superseded identities name partitions an older build already populated, so a client
 * upgrade adopts that jar instead of deriving an empty one: `pairingAuthorityConnectionIdentity`
 * is the pairing-revision identity (equal to the current one for hosts that never re-pair in
 * place), and `legacyAuthorityConnectionIdentity` the older per-process one.
 */
export type BrowserClientPageAuthorityIdentity = {
  authorityConnectionIdentity: string
  pairingAuthorityConnectionIdentity: string
  legacyAuthorityConnectionIdentity: string
}

// Why pick: transition inputs carry the whole host start, and only the identity belongs here.
export function pageAuthorityIdentity(
  input: BrowserClientPageAuthorityIdentity
): BrowserClientPageAuthorityIdentity {
  return {
    authorityConnectionIdentity: input.authorityConnectionIdentity,
    pairingAuthorityConnectionIdentity: input.pairingAuthorityConnectionIdentity,
    legacyAuthorityConnectionIdentity: input.legacyAuthorityConnectionIdentity
  }
}

export type BrowserClientPageCommandExecutorDependencies = BrowserClientPageAuthorityIdentity & {
  orcaProfileId: string
  /** Environment record that owns this host's partitions for storage lifecycle. */
  storageScope: string
  retainNetworkRoute(
    executionHostKey: string,
    signal: AbortSignal
  ): Promise<BrowserClientPageNetworkRoute>
  selectRenderer(): BrowserClientPageRenderer
  routeSessions: Pick<BrowserRouteSessionRegistry, 'preparePage'>
  routeWebContents: BrowserClientPageLifecycleRegistry
  guestBinding: BrowserClientPageGuestBinding
  executeAutomation(
    input: {
      browserPageId: string
      pageHostGeneration: number
      browserProfileId: string
      method: BrowserClientAutomationMethod
      params: Record<string, unknown>
      registration: BrowserClientRetainedPage['registration']
    },
    signal: AbortSignal
  ): Promise<unknown>
  retireAutomation(input: {
    keepGuestBinding?: boolean
    browserPageId: string
    pageHostGeneration: number
    registration: BrowserClientRetainedPage['registration']
  }): Promise<void>
  onPageUnavailable?(browserPageId: string, pageHostGeneration: number): void
  // Why: remote-path uploads need the negotiated file channel; without both the command fails closed.
  fileChannel?: BrowserClientFileChannelTransport
  uploadStaging?: BrowserClientUploadStaging
  maxPages?: number
}
