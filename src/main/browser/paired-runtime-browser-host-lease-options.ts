import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import type { PairingOffer } from '../../shared/pairing'
import type { RemoteRuntimeSubscriptionOptions } from '../../shared/remote-runtime-client'

export type PairedRuntimeBrowserHostLeaseOptions = {
  pairing: PairingOffer
  authorityRuntimeId: string
  browserHostClientId: string
  hostCapabilities: readonly string[]
  pageCommandProtocolVersion?: 1
  pageInventoryProtocolVersion?: 1
  getPageInventory?: () => readonly BrowserClientHostedPageInventory[]
  onPageCommand?: (
    command: BrowserClientHostCommandEvent
  ) => BrowserClientHostCommandResult | Promise<BrowserClientHostCommandResult>
  onAuthority?: (authority: BrowserClientHostLeaseAuthority) => void
  maxConcurrentCommandResults?: number
  maxUnsettledCommandResults?: number
  timeoutMs?: number
  subscription?: RemoteRuntimeSubscriptionOptions
  onError?: (error: Error) => void
}
