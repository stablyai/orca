import type {
  BrowserClientHostedPageInventory,
  BrowserClientHostCommandEvent,
  BrowserClientHostLeaseAuthority
} from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import {
  BROWSER_CLIENT_HOST_COMMAND_RESULT_CHUNK_METHOD,
  type BrowserClientAutomationResult as BrowserClientHostCommandResult
} from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import { BROWSER_CLIENT_PAGE_METADATA_METHOD } from '../../../../shared/browser/client-hosting/browser-client-page-metadata-protocol'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import type { PairedRuntimeConnection } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import type { RemoteRuntimeSubscriptionOptions } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { BrowserClientFileChannelAvailability } from '../file-transfers/browser-client-file-channel-transport'
import { BrowserClientHostCommandDispatcher } from '../commands/browser-client-host-command-dispatcher'
import type {
  CommandHandler,
  DispatcherOptions
} from '../commands/browser-client-host-command-state'
import { PairedRuntimeBrowserHostLease } from '../leases/paired-runtime-browser-host-lease'
import { stageBrowserHostCommandResult } from '../commands/browser-host-command-result-staging'

type DispatcherLimits = Omit<DispatcherOptions, 'authority' | 'handler'>

export type PairedRuntimeBrowserClientHostOptions = {
  connection: PairedRuntimeConnection
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
      connection: options.connection,
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

  // Only unsupported file channels permit desktop download fallback; outages must not move the destination.
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
    return this.lease.sendHostRequest(BROWSER_CLIENT_PAGE_METADATA_METHOD, params, timeoutMs)
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
      handler: async (command, signal) =>
        stageBrowserHostCommandResult(
          command,
          await this.options.handler(command, signal),
          (params) => this.sendCommandResultChunk(params),
          signal
        ),
      ...this.options.dispatcher
    })
  }

  private async sendCommandResultChunk(params: unknown): Promise<void> {
    const response = await this.lease.sendHostRequest(
      BROWSER_CLIENT_HOST_COMMAND_RESULT_CHUNK_METHOD,
      params,
      this.options.timeoutMs ?? 15_000
    )
    if (!response.ok) {
      throw new RemoteRuntimeClientError(response.error.code, response.error.message)
    }
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
