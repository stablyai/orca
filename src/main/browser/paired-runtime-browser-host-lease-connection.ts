import {
  BrowserClientHostEvent,
  type BrowserClientHostCommandEvent,
  type BrowserClientHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription,
  type RemoteRuntimeSubscriptionCallbacks
} from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { createBrowserClientHostAttachRequest } from './browser-client-host-attach-request'
import { sameBrowserClientHostLeaseAuthority } from './browser-client-host-command-authority'
import type { PairedRuntimeBrowserHostLeaseOptions } from './paired-runtime-browser-host-lease-options'

type PairedRuntimeBrowserHostLeaseConnectionOptions = {
  lease: PairedRuntimeBrowserHostLeaseOptions
  reconnect: boolean
  timeoutMs: number
  expectedAuthority: BrowserClientHostLeaseAuthority | null
  onReady(authority: BrowserClientHostLeaseAuthority): void
  onCommand(command: BrowserClientHostCommandEvent, rejectReady: (error: Error) => void): void
  onFailure(connection: PairedRuntimeBrowserHostLeaseConnection, error: Error): void
  onCleanupError(error: Error): void
}

export class PairedRuntimeBrowserHostLeaseConnection {
  private subscription: RemoteRuntimeSubscription | null = null
  private readyTimeout: ReturnType<typeof setTimeout> | null = null
  private resolveReady = (_authority: BrowserClientHostLeaseAuthority): void => {}
  private rejectReady = (_error: Error): void => {}
  private authority: BrowserClientHostLeaseAuthority | null = null
  private ready = false
  private failed = false
  private closed = false

  constructor(private readonly options: PairedRuntimeBrowserHostLeaseConnectionOptions) {}

  get active(): boolean {
    return !this.closed && !this.failed
  }

  get hasSubscription(): boolean {
    return this.subscription !== null
  }

  get sendRequest(): RemoteRuntimeSubscription['sendRequest'] | undefined {
    return this.subscription?.sendRequest
  }

  async start(): Promise<BrowserClientHostLeaseAuthority> {
    const ready = new Promise<BrowserClientHostLeaseAuthority>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
    void ready.catch(() => undefined)
    const request = createBrowserClientHostAttachRequest(this.options.lease)
    try {
      let subscription: RemoteRuntimeSubscription
      try {
        subscription = await subscribeRemoteRuntimeRequest(
          this.options.lease.pairing,
          'browser.clientHost.attach',
          request.params,
          this.options.timeoutMs,
          this.callbacks(request),
          {
            ...this.options.lease.subscription,
            // Why metadata is advertised here: page metadata is published back over this very
            // connection (the runtime refuses page traffic from any other), and its handler gates
            // on the capability being declared by the connection it arrives on.
            clientCapabilities: [
              ...(this.options.lease.subscription?.clientCapabilities ?? []),
              BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
              BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY
            ]
          }
        )
      } catch (error) {
        this.fail(asError(error))
        return await ready
      }
      if (this.closed || this.failed) {
        subscription.close()
        this.rejectReady(new Error('Browser host lease closed during startup'))
        return await ready
      }
      this.subscription = subscription
      this.readyTimeout = setTimeout(
        () =>
          this.fail(
            new RemoteRuntimeClientError('runtime_timeout', 'Browser host lease attach timed out.')
          ),
        this.options.timeoutMs
      )
      return await ready
    } finally {
      this.clearReadyTimeout()
    }
  }

  close(error: Error): void {
    if (this.closed) {
      return
    }
    this.closed = true
    if (this.subscription) {
      this.rejectReady(error)
    }
    this.clearReadyTimeout()
    this.subscription?.close()
    this.subscription = null
  }

  fail(error: Error): void {
    if (!this.active) {
      return
    }
    this.failed = true
    this.rejectReady(error)
    this.clearReadyTimeout()
    try {
      this.subscription?.close()
    } catch (error) {
      this.options.onCleanupError(asError(error))
    }
    this.subscription = null
    this.options.onFailure(this, error)
  }

  private callbacks(request: ReturnType<typeof createBrowserClientHostAttachRequest>) {
    const callbacks: RemoteRuntimeSubscriptionCallbacks = {
      onResponse: (response) => this.handleResponse(response, request),
      onError: (error) => this.fail(error),
      onClose: () =>
        this.fail(
          new RemoteRuntimeClientError(
            'remote_runtime_unavailable',
            'Remote runtime browser host lease transport closed.'
          )
        )
    }
    return callbacks
  }

  private handleResponse(
    response: Parameters<RemoteRuntimeSubscriptionCallbacks['onResponse']>[0],
    request: ReturnType<typeof createBrowserClientHostAttachRequest>
  ): void {
    if (!this.active) {
      return
    }
    if (!response.ok) {
      this.fail(new RemoteRuntimeClientError(response.error.code, response.error.message))
      return
    }
    const parsed = BrowserClientHostEvent.safeParse(response.result)
    if (!parsed.success || response._meta.runtimeId !== this.options.lease.authorityRuntimeId) {
      this.fail(new Error('Invalid browser host lease response'))
      return
    }
    if (parsed.data.type === 'command') {
      if (!this.ready) {
        this.fail(new Error('Browser host page command received before readiness'))
        return
      }
      this.options.onCommand(parsed.data, this.rejectReady)
      return
    }
    if (parsed.data.type === 'revoked') {
      this.handleRevocation(parsed.data)
      return
    }
    this.acceptReady(parsed.data, request)
  }

  private acceptReady(
    ready: Extract<ReturnType<typeof BrowserClientHostEvent.parse>, { type: 'ready' }>,
    request: ReturnType<typeof createBrowserClientHostAttachRequest>
  ): void {
    if (this.ready) {
      return
    }
    if (
      !matchesOptionalProtocol(
        ready.pageCommandProtocolVersion,
        request.pageCommandProtocolVersion
      ) ||
      !matchesOptionalProtocol(
        ready.pageInventoryProtocolVersion,
        request.pageInventoryProtocolVersion
      ) ||
      !matchesOptionalProtocol(
        ready.leaseReconnectProtocolVersion,
        request.leaseReconnectProtocolVersion
      ) ||
      !matchesOptionalProtocol(
        ready.pageReconciliationProtocolVersion,
        request.pageReconciliationProtocolVersion
      ) ||
      !matchesOptionalProtocol(
        ready.fileChannelProtocolVersion,
        request.fileChannelProtocolVersion
      ) ||
      (ready.fileChannelProtocolVersion === 1 && ready.pageCommandProtocolVersion !== 1) ||
      (ready.leaseReconnectProtocolVersion === 1 && ready.pageInventoryProtocolVersion !== 1) ||
      (ready.pageReconciliationProtocolVersion === 1 &&
        (ready.pageCommandProtocolVersion !== 1 || ready.pageInventoryProtocolVersion !== 1)) ||
      (this.options.reconnect && ready.leaseReconnectProtocolVersion !== 1)
    ) {
      this.fail(new Error('Invalid browser host lease response'))
      return
    }
    if (ready.pageCommandProtocolVersion && !this.subscription?.sendRequest) {
      this.fail(new Error('Browser host command result transport unavailable'))
      return
    }
    const authority = browserHostLeaseAuthority(this.options.lease, ready)
    if (
      this.options.expectedAuthority &&
      !sameBrowserClientHostLeaseAuthority(this.options.expectedAuthority, authority)
    ) {
      this.fail(new Error('Browser host lease authority changed in place'))
      return
    }
    try {
      this.options.onReady(authority)
    } catch (error) {
      this.fail(asError(error))
      return
    }
    this.authority = authority
    this.ready = true
    this.clearReadyTimeout()
    this.resolveReady(authority)
  }

  private handleRevocation(
    revoked: Extract<ReturnType<typeof BrowserClientHostEvent.parse>, { type: 'revoked' }>
  ): void {
    const authority = this.authority ?? this.options.expectedAuthority
    if (
      !authority ||
      authority.authorityEpoch !== revoked.authorityEpoch ||
      authority.browserHostGeneration !== revoked.browserHostGeneration
    ) {
      this.fail(new Error('Invalid browser host lease revocation'))
      return
    }
    this.fail(new Error(`Browser host lease revoked: ${revoked.reason}`))
  }

  private clearReadyTimeout(): void {
    if (this.readyTimeout) {
      clearTimeout(this.readyTimeout)
      this.readyTimeout = null
    }
  }
}

function browserHostLeaseAuthority(
  options: PairedRuntimeBrowserHostLeaseOptions,
  ready: Extract<ReturnType<typeof BrowserClientHostEvent.parse>, { type: 'ready' }>
): BrowserClientHostLeaseAuthority {
  return Object.freeze({
    authorityRuntimeId: options.authorityRuntimeId,
    authorityEpoch: ready.authorityEpoch,
    browserHostClientId: options.browserHostClientId,
    browserHostGeneration: ready.browserHostGeneration,
    ...(ready.pageCommandProtocolVersion
      ? { pageCommandProtocolVersion: ready.pageCommandProtocolVersion }
      : {}),
    ...(ready.pageInventoryProtocolVersion
      ? { pageInventoryProtocolVersion: ready.pageInventoryProtocolVersion }
      : {}),
    ...(ready.leaseReconnectProtocolVersion
      ? { leaseReconnectProtocolVersion: ready.leaseReconnectProtocolVersion }
      : {}),
    ...(ready.pageReconciliationProtocolVersion
      ? { pageReconciliationProtocolVersion: ready.pageReconciliationProtocolVersion }
      : {}),
    ...(ready.fileChannelProtocolVersion
      ? { fileChannelProtocolVersion: ready.fileChannelProtocolVersion }
      : {})
  })
}

function matchesOptionalProtocol(actual: 1 | undefined, requested: 1 | undefined): boolean {
  return actual === undefined || actual === requested
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
