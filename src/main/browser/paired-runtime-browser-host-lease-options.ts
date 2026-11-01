import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import type { PairedRuntimeConnection } from '../../shared/paired-runtime-connection'
import type { RemoteRuntimeSubscriptionOptions } from '../../shared/remote-runtime/requests/remote-runtime-subscription-contract'

export type PairedRuntimeBrowserHostLeaseOptions = {
  connection: PairedRuntimeConnection
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
