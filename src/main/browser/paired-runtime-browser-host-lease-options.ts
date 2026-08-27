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
  pageReconciliationProtocolVersion?: 1
  leaseReconnectProtocolVersion?: 1
  fileChannelProtocolVersion?: 1
  getPageInventory?: () => readonly BrowserClientHostedPageInventory[]
  onPageCommand?: (
    command: BrowserClientHostCommandEvent
  ) => BrowserClientHostCommandResult | Promise<BrowserClientHostCommandResult>
  onAuthority?: (authority: BrowserClientHostLeaseAuthority) => void
  onTransportLost?: (error: Error) => void
  onReconnected?: (authority: BrowserClientHostLeaseAuthority) => void
  reconnectGraceMs?: number
  reconnectRetryDelayMs?: number
  maxConcurrentCommandResults?: number
  maxUnsettledCommandResults?: number
  timeoutMs?: number
  subscription?: RemoteRuntimeSubscriptionOptions
  onError?: (error: Error) => void
}
