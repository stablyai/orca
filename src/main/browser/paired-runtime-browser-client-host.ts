import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResult,
  BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import type { PairingOffer } from '../../shared/pairing'
import type { RemoteRuntimeSubscriptionOptions } from '../../shared/remote-runtime-client'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { BrowserClientFileChannelAvailability } from './browser-client-file-channel-transport'
import { BrowserClientHostCommandDispatcher } from './browser-client-host-command-dispatcher'
import type { CommandHandler, DispatcherOptions } from './browser-client-host-command-state'
import { PairedRuntimeBrowserHostLease } from './paired-runtime-browser-host-lease'

type DispatcherLimits = Omit<DispatcherOptions, 'authority' | 'handler'>

export type PairedRuntimeBrowserClientHostOptions = {
  pairing: PairingOffer
  authorityRuntimeId: string
  browserHostClientId: string
  hostCapabilities: readonly string[]
  handler: CommandHandler
  getPageInventory?: () => readonly BrowserClientHostedPageInventory[]
  pageReconciliationProtocolVersion?: 1
  fileChannelProtocolVersion?: 1
  dispatcher?: DispatcherLimits
  timeoutMs?: number
  reconnectRetryDelayMs?: number
  subscription?: RemoteRuntimeSubscriptionOptions
  maxConcurrentCommandResults?: number
  maxUnsettledCommandResults?: number
  onAuthority?: (authority: BrowserClientHostLeaseAuthority) => void
  onTransportLost?: (error: Error) => void
  onReconnected?: (authority: BrowserClientHostLeaseAuthority) => void
  onError?: (error: Error) => void
}

export class PairedRuntimeBrowserClientHost {
  private readonly lease: PairedRuntimeBrowserHostLease
  private dispatcher: BrowserClientHostCommandDispatcher | null = null
  private authority: BrowserClientHostLeaseAuthority | null = null
  private closePromise: Promise<boolean> | null = null
  private closed = false
  private errorReported = false

  constructor(private readonly options: PairedRuntimeBrowserClientHostOptions) {
    this.lease = new PairedRuntimeBrowserHostLease({
      pairing: options.pairing,
      authorityRuntimeId: options.authorityRuntimeId,
      browserHostClientId: options.browserHostClientId,
      hostCapabilities: options.hostCapabilities,
      pageCommandProtocolVersion: 1,
      ...(options.fileChannelProtocolVersion
        ? { fileChannelProtocolVersion: options.fileChannelProtocolVersion }
        : {}),
      ...(options.getPageInventory
        ? {
            pageInventoryProtocolVersion: 1,
            leaseReconnectProtocolVersion: 1,
            ...(options.pageReconciliationProtocolVersion
              ? { pageReconciliationProtocolVersion: options.pageReconciliationProtocolVersion }
              : {}),
            getPageInventory: options.getPageInventory
          }
        : {}),
      onAuthority: (authority) => this.activateDispatcher(authority),
      onTransportLost: options.onTransportLost,
      onReconnected: options.onReconnected,
      onPageCommand: (command) => this.dispatch(command),
      timeoutMs: options.timeoutMs,
      reconnectRetryDelayMs: options.reconnectRetryDelayMs,
      subscription: options.subscription,
      maxConcurrentCommandResults: options.maxConcurrentCommandResults,
      maxUnsettledCommandResults: options.maxUnsettledCommandResults,
      onError: (error) => this.handleLeaseError(error)
    })
  }

  start(): Promise<BrowserClientHostLeaseAuthority> {
    if (this.closed) {
      return Promise.reject(new Error('Browser client host is closed'))
    }
    return this.lease.start()
  }

  close(error = new Error('Browser client host is closed')): Promise<boolean> {
    this.closePromise ??= this.closeHost(error)
    return this.closePromise
  }

  retirePage(browserPageId: string, pageHostGeneration: number): Promise<boolean> {
    if (!this.dispatcher || this.closed) {
      return Promise.reject(new Error('Browser client host dispatcher is unavailable'))
    }
    return this.dispatcher.retirePage(browserPageId, pageHostGeneration)
  }

  get fileChannelNegotiated(): boolean {
    return !this.closed && this.lease.fileChannelNegotiated
  }

  // An attached authority that never named the file channel is an older host, the one case a
  // download may keep its desktop destination. Anything else — no lease yet, transport lost, host
  // closed — is merely unavailable, and guessing "local" there would silently move the bytes.
  get fileChannelAvailability(): BrowserClientFileChannelAvailability {
    if (this.fileChannelNegotiated) {
      return 'negotiated'
    }
    return this.authority && this.authority.fileChannelProtocolVersion !== 1
      ? 'unsupported'
      : 'unavailable'
  }

  sendFileChannelRequest(
    method: string,
    params: unknown,
    timeoutMs: number
  ): Promise<RuntimeRpcResponse<unknown>> {
    return this.lease.sendFileChannelRequest(method, params, timeoutMs)
  }

  sendPageMetadataRequest(
    params: unknown,
    timeoutMs: number
  ): Promise<RuntimeRpcResponse<unknown>> {
    return this.lease.sendPageMetadataRequest(params, timeoutMs)
  }

  refreshPageInventory(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Browser client host is closed'))
    }
    return this.lease.refreshPageInventory()
  }

  forgetPage(browserPageId: string, pageHostGeneration: number): boolean {
    return this.dispatcher?.forgetPage(browserPageId, pageHostGeneration) ?? false
  }

  whenHandlersSettled(): Promise<void> {
    return this.dispatcher?.whenClosed() ?? Promise.resolve()
  }

  private activateDispatcher(authority: BrowserClientHostLeaseAuthority): void {
    if (this.closed || this.dispatcher) {
      throw new Error('Browser client host authority is unavailable')
    }
    this.authority = authority
    this.options.onAuthority?.(authority)
    this.dispatcher = new BrowserClientHostCommandDispatcher({
      authority,
      handler: this.options.handler,
      ...this.options.dispatcher
    })
  }

  private dispatch(
    command: BrowserClientHostCommandEvent
  ): Promise<BrowserClientHostCommandResult> {
    if (!this.dispatcher || this.closed) {
      return Promise.reject(new Error('Browser client host dispatcher is unavailable'))
    }
    return this.dispatcher.dispatch(command)
  }

  private async closeHost(error: Error): Promise<boolean> {
    this.closed = true
    let leaseError: Error | null = null
    try {
      await this.lease.close(error)
    } catch (caught) {
      leaseError = caught instanceof Error ? caught : new Error(String(caught))
    }
    const settled = this.dispatcher ? await this.dispatcher.close() : true
    if (leaseError !== null) {
      throw leaseError
    }
    return settled
  }

  private handleLeaseError(error: Error): void {
    void this.close(error).catch(() => undefined)
    if (this.errorReported) {
      return
    }
    this.errorReported = true
    try {
      this.options.onError?.(error)
    } catch {
      // Reporting cannot retain a failed browser host.
    }
  }
}
