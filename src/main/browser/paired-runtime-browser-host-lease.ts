import {
  BrowserClientHostCommandResult,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostCommandResult as BrowserClientHostCommandResultType,
  type BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import { BROWSER_CLIENT_PAGE_METADATA_METHOD } from '../../shared/browser-client-page-metadata-protocol'
import { assertBrowserClientHostAttachOptions } from './browser-client-host-attach-request'
import {
  BrowserHostReconnectDelay,
  resolveBrowserHostReconnectDelay
} from './browser-host-lease-reconnect-delay'
import { reconnectBrowserHostLeaseUntil } from './browser-host-lease-reconnect-attempts'
import { requireBrowserHostLeaseSendRequest } from './browser-host-lease-request-sender'
import { submitBrowserHostCommandResult } from './browser-host-command-result-submission'
import {
  BrowserHostCommandResultSettler,
  type BrowserHostCommandResultAdmission
} from './browser-host-command-result-settler'
import { requestBrowserHostLeaseInventoryRefresh } from './browser-host-lease-inventory-refresh'
import { PairedRuntimeBrowserHostLeaseConnection } from './paired-runtime-browser-host-lease-connection'
import type { PairedRuntimeBrowserHostLeaseOptions } from './paired-runtime-browser-host-lease-options'
import {
  attachBrowserHostWithInitialAdmissionRetry,
  isRecoverableBrowserHostLeaseError
} from './browser-host-admission-recovery'

export class PairedRuntimeBrowserHostLease {
  private connection: PairedRuntimeBrowserHostLeaseConnection | null = null
  private startPromise: Promise<BrowserClientHostLeaseAuthority> | null = null
  private reconnectPromise: Promise<void> | null = null
  private closePromise: Promise<void> | null = null
  private readonly reconnectDelay = new BrowserHostReconnectDelay()
  private authority: BrowserClientHostLeaseAuthority | null = null
  private readonly commandResultSettler: BrowserHostCommandResultSettler
  private readonly reconnectGraceMs: number
  private readonly reconnectRetryDelayMs: number
  /** Tracks the live connection's negotiation, which a reconnect may drop or gain. */
  private fileChannelActive = false
  private closed = false

  constructor(private readonly options: PairedRuntimeBrowserHostLeaseOptions) {
    assertBrowserClientHostAttachOptions(options)
    this.reconnectGraceMs = resolveBrowserHostReconnectDelay(
      options.reconnectGraceMs,
      options.timeoutMs ?? 15_000
    )
    this.reconnectRetryDelayMs = resolveBrowserHostReconnectDelay(options.reconnectRetryDelayMs)
    this.commandResultSettler = new BrowserHostCommandResultSettler({
      maxConcurrent: options.maxConcurrentCommandResults,
      maxUnsettled: options.maxUnsettledCommandResults,
      submit: (command, result) => this.submitPageCommandResult(command, result),
      onError: (error, rejectReady) => this.handleCommandResultFailure(error, rejectReady)
    })
  }

  start(): Promise<BrowserClientHostLeaseAuthority> {
    if (this.closed) {
      return Promise.reject(new Error('Browser host lease is closed'))
    }
    this.startPromise ??= this.startLease()
    return this.startPromise
  }

  async close(error = new Error('Browser host lease is closed')): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.closed = true
    this.reconnectDelay.release()
    this.closePromise = this.closeLease(error)
    return this.closePromise
  }

  get fileChannelNegotiated(): boolean {
    return !this.closed && this.fileChannelActive
  }

  /** Unversioned, unlike the file channel: an older runtime answers with a reportable error. */
  sendPageMetadataRequest(params: unknown, timeoutMs: number) {
    // Closing drops the connection in the same turn, so its absence is what "closed" means here.
    return requireBrowserHostLeaseSendRequest(
      this.connection?.sendRequest,
      'Remote runtime browser host lease is unavailable.'
    )(BROWSER_CLIENT_PAGE_METADATA_METHOD, params, timeoutMs)
  }

  sendFileChannelRequest(method: string, params: unknown, timeoutMs: number) {
    return requireBrowserHostLeaseSendRequest(
      this.fileChannelNegotiated ? this.connection?.sendRequest : undefined,
      'Remote runtime browser file channel is unavailable.'
    )(method, params, timeoutMs)
  }

  refreshPageInventory(): Promise<void> {
    return requestBrowserHostLeaseInventoryRefresh(
      {
        closed: this.closed,
        reconnectPromise: this.reconnectPromise,
        supportsInventoryRefresh:
          this.authority?.leaseReconnectProtocolVersion === 1 && !!this.options.getPageInventory,
        connection: this.connection
      },
      () => this.reconnectPromise
    )
  }

  private async startLease(): Promise<BrowserClientHostLeaseAuthority> {
    try {
      return await attachBrowserHostWithInitialAdmissionRetry({
        attach: (timeoutMs) => this.attach(false, timeoutMs),
        browserHostClientId: this.options.browserHostClientId,
        delay: this.reconnectDelay,
        isClosed: () => this.closed,
        retryDelayMs: this.reconnectRetryDelayMs,
        timeoutMs: this.options.timeoutMs ?? 15_000
      })
    } catch (error) {
      const leaseError = asError(error)
      this.failTerminal(leaseError)
      await this.closePromise?.catch(() => undefined)
      throw leaseError
    }
  }

  private attach(reconnect: boolean, timeoutMs: number): Promise<BrowserClientHostLeaseAuthority> {
    const connection = new PairedRuntimeBrowserHostLeaseConnection({
      lease: this.options,
      reconnect,
      timeoutMs,
      expectedAuthority: reconnect ? this.authority : null,
      onReady: (authority) => this.acceptAuthority(authority),
      onCommand: (command, rejectReady) => this.handlePageCommand(command, rejectReady),
      onFailure: (failed, error) => this.handleConnectionFailure(failed, error),
      onCleanupError: (error) => this.reportError(error)
    })
    this.connection = connection
    return connection.start()
  }

  private acceptAuthority(authority: BrowserClientHostLeaseAuthority): void {
    this.fileChannelActive = authority.fileChannelProtocolVersion === 1
    if (this.authority) {
      this.reconnectPromise = null
      this.options.onReconnected?.(authority)
      return
    }
    this.options.onAuthority?.(authority)
    this.authority = authority
  }

  private handleConnectionFailure(
    connection: PairedRuntimeBrowserHostLeaseConnection,
    error: Error
  ): void {
    if (this.closed || this.connection !== connection || !this.authority) {
      return
    }
    if (this.canReconnect(error)) {
      this.beginReconnect(error)
      return
    }
    this.failTerminal(error)
  }

  private beginReconnect(error: Error): void {
    if (this.closed || this.reconnectPromise) {
      return
    }
    try {
      this.options.onTransportLost?.(error)
    } catch (callbackError) {
      this.failTerminal(asError(callbackError))
      return
    }
    const reconnecting = this.reconnectUntil(Date.now() + this.reconnectGraceMs)
    this.reconnectPromise = reconnecting
    void reconnecting
      .catch((reconnectError) => this.failTerminal(asError(reconnectError)))
      .finally(() => {
        if (this.reconnectPromise === reconnecting) {
          this.reconnectPromise = null
        }
      })
  }

  private async reconnectUntil(deadline: number): Promise<void> {
    return reconnectBrowserHostLeaseUntil({
      deadline,
      delay: this.reconnectDelay,
      retryDelayMs: this.reconnectRetryDelayMs,
      browserHostClientId: this.options.browserHostClientId,
      timeoutMs: this.options.timeoutMs ?? 15_000,
      isClosed: () => this.closed,
      attach: (timeoutMs) => this.attach(true, timeoutMs).then(() => undefined),
      canReconnect: (error) => this.canReconnect(error)
    })
  }

  private canReconnect(error: Error): boolean {
    return (
      this.authority?.leaseReconnectProtocolVersion === 1 &&
      isRecoverableBrowserHostLeaseError(error)
    )
  }

  private failTerminal(error: Error): void {
    if (this.closed) {
      return
    }
    const closing = this.close(error)
    this.reportError(error)
    void closing.catch((closeError) => this.reportError(asError(closeError)))
  }

  private handlePageCommand(
    command: BrowserClientHostCommandEvent,
    rejectReady: (error: Error) => void
  ): void {
    const authority = this.authority
    if (
      !authority?.pageCommandProtocolVersion ||
      !this.options.onPageCommand ||
      command.pageCommandProtocolVersion !== authority.pageCommandProtocolVersion ||
      command.pageReconciliationProtocolVersion !== authority.pageReconciliationProtocolVersion
    ) {
      this.failTerminal(new Error('Unnegotiated browser host page command'))
      return
    }
    if (
      command.authorityRuntimeId !== authority.authorityRuntimeId ||
      command.authorityEpoch !== authority.authorityEpoch ||
      command.browserHostClientId !== authority.browserHostClientId ||
      command.browserHostGeneration !== authority.browserHostGeneration
    ) {
      this.failTerminal(new Error('Stale browser host page command'))
      return
    }
    const admissionResult = this.commandResultSettler.admit(command)
    if (!admissionResult) {
      this.failTerminal(new Error('Browser host command result capacity reached'))
      return
    }
    const { admission, duplicate } = admissionResult
    let handled: Promise<BrowserClientHostCommandResultType>
    try {
      handled = Promise.resolve(this.options.onPageCommand(command))
    } catch (error) {
      if (!duplicate) {
        this.commandResultSettler.release(admission)
      }
      this.failTerminal(asError(error))
      return
    }
    if (duplicate) {
      void handled.catch((error) => this.failTerminal(asError(error)))
      return
    }
    void handled
      .then((result) => this.enqueuePageCommandResult(admission, command, result, rejectReady))
      .catch((error) => {
        this.commandResultSettler.release(admission)
        this.failTerminal(asError(error))
      })
  }

  private enqueuePageCommandResult(
    admission: BrowserHostCommandResultAdmission,
    command: BrowserClientHostCommandEvent,
    candidate: BrowserClientHostCommandResultType,
    rejectReady: (error: Error) => void
  ): void {
    const result = BrowserClientHostCommandResult.parse(candidate)
    this.commandResultSettler.enqueue(admission, command, result, rejectReady)
  }

  private async submitPageCommandResult(
    command: BrowserClientHostCommandEvent,
    candidate: BrowserClientHostCommandResultType
  ): Promise<void> {
    if (this.closed) {
      return
    }
    await submitBrowserHostCommandResult(
      requireBrowserHostLeaseSendRequest(
        this.connection?.sendRequest,
        'Remote runtime browser host command result transport is unavailable.'
      ),
      command,
      candidate,
      this.options.timeoutMs ?? 15_000
    )
  }

  private handleCommandResultFailure(error: Error, rejectReady: (error: Error) => void): void {
    const connection = this.connection
    if (connection?.active && this.canReconnect(error)) {
      connection.fail(error)
      return
    }
    if (this.canReconnect(error)) {
      this.beginReconnect(error)
      return
    }
    rejectReady(error)
    this.failTerminal(error)
  }

  private async closeLease(error: Error): Promise<void> {
    this.commandResultSettler.close()
    this.connection?.close(error)
    this.connection = null
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error)
    } catch {}
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
