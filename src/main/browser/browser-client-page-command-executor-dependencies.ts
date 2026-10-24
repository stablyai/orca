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

/** Superseded connection identities let upgrades adopt populated partitions. */
export type BrowserClientPageAuthorityIdentity = {
  authorityConnectionIdentity: string
  /** Previous identity tied to the pairing revision. */
  pairingAuthorityConnectionIdentity: string
  /** Earlier per-process identity. */
  legacyAuthorityConnectionIdentity: string
}

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
  // Remote uploads require both a negotiated file channel and upload staging.
  fileChannel?: BrowserClientFileChannelTransport
  uploadStaging?: BrowserClientUploadStaging
  maxPages?: number
}
