import type { BrowserClientAutomationMethod } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import type { BrowserClientFileChannelTransport } from '../../client-hosts/file-transfers/browser-client-file-channel-transport'
import type { BrowserClientPageGuestBinding } from '../lifecycle/browser-client-page-guest-binding'
import type { BrowserClientUploadStaging } from '../../client-hosts/file-transfers/browser-client-upload-staging'
import type { BrowserClientPageNetworkRoute } from '../../network/client-routes/browser-client-page-network-route'
import type { BrowserClientPageRenderer } from '../renderer/browser-client-page-renderer-contract'
import type { BrowserRouteSessionRegistry } from '../../routing/sessions/browser-route-session-registry'
import type {
  BrowserClientPageLifecycleRegistry,
  BrowserClientRetainedPage
} from '../lifecycle/browser-client-page-retained-state'

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
      agent: boolean
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
