import {
  BrowserNetworkTunnelEvent,
  type BrowserHostLeaseAuthority,
  type BrowserNetworkExecutionHost
} from '../../shared/browser-client-host-protocol'
import type { PairingOffer } from '../../shared/pairing'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription,
  type RemoteRuntimeSubscriptionOptions
} from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import type { BrowserNetworkTunnelOutboundMemoryLease } from './browser-network-tunnel-outbound-memory-budget'

const BROWSER_TUNNEL_WS_SOFT_CAP_BYTES = 1024 * 1024
const BROWSER_TUNNEL_WS_MAX_QUEUED_BYTES = 7 * 1024 * 1024

type PairedRuntimeBrowserNetworkTransportOptions = {
  pairing: PairingOffer
  lease: BrowserHostLeaseAuthority
  executionHost: BrowserNetworkExecutionHost
  timeoutMs: number
  subscription?: RemoteRuntimeSubscriptionOptions
  outboundMemory: BrowserNetworkTunnelOutboundMemoryLease
  maxStreamIds?: number
  minimumTunnelGeneration: number
  onReady: (transport: PairedRuntimeBrowserNetworkTransport, generation: number) => void
  onFailure: (
    transport: PairedRuntimeBrowserNetworkTransport,
    error: Error,
    cleanupFailures: Error[]
  ) => void
}

export class PairedRuntimeBrowserNetworkTransport {
  private readonly options: PairedRuntimeBrowserNetworkTransportOptions
  private tunnelValue: BrowserNetworkTunnelClient | null = null
  private subscription: RemoteRuntimeSubscription | null = null
  private startPromise: Promise<BrowserNetworkTunnelClient> | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private closed = false

  constructor(options: PairedRuntimeBrowserNetworkTransportOptions) {
    this.options = options
  }

  get tunnel(): BrowserNetworkTunnelClient | null {
    return this.tunnelValue
  }

  start(): Promise<BrowserNetworkTunnelClient> {
    this.startPromise ??= this.startTransport()
    return this.startPromise
  }

  close(error = new Error('Browser network transport closed')): Error[] {
    if (this.closed) {
      return []
    }
    this.closed = true
    this.rejectReady?.(error)
    this.rejectReady = null
    const failures: Error[] = []
    try {
      this.tunnelValue?.close(error)
    } catch (closeError) {
      failures.push(asError(closeError))
    }
    this.tunnelValue = null
    try {
      this.subscription?.close()
    } catch (closeError) {
      failures.push(asError(closeError))
    }
    this.subscription = null
    return failures
  }

  private async startTransport(): Promise<BrowserNetworkTunnelClient> {
    let resolveReady = (): void => {}
    let rejectReady = (_error: Error): void => {}
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void ready.catch(() => undefined)
    this.rejectReady = rejectReady
    let readyTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      const subscription = await subscribeRemoteRuntimeRequest(
        this.options.pairing,
        'network.browserTunnel',
        {
          authorityRuntimeId: this.options.lease.authorityRuntimeId,
          authorityEpoch: this.options.lease.authorityEpoch,
          browserHostClientId: this.options.lease.browserHostClientId,
          browserHostGeneration: this.options.lease.browserHostGeneration,
          executionHost: this.options.executionHost
        },
        this.options.timeoutMs,
        {
          onResponse: (response) => {
            if (this.closed) {
              return
            }
            if (!response.ok) {
              this.fail(
                new RemoteRuntimeClientError(response.error.code, response.error.message),
                rejectReady
              )
              return
            }
            const parsed = BrowserNetworkTunnelEvent.safeParse(response.result)
            if (
              !parsed.success ||
              response._meta.runtimeId !== this.options.lease.authorityRuntimeId
            ) {
              this.fail(new Error('Invalid browser network route response'), rejectReady)
              return
            }
            const result = parsed.data
            if (result.type === 'ready') {
              this.acceptReady(result.tunnelGeneration, resolveReady, rejectReady)
              return
            }
            if (this.tunnelValue?.generation === result.tunnelGeneration) {
              this.fail(new Error('Browser network route closed by the runtime'), rejectReady)
              return
            }
            this.fail(
              new Error('Browser network route closed with an unknown generation'),
              rejectReady
            )
          },
          onBinary: (bytes) => {
            if (this.closed) {
              return
            }
            if (!this.tunnelValue) {
              this.fail(
                new Error('Browser network route received binary data before readiness'),
                rejectReady
              )
              return
            }
            this.tunnelValue.handleBinary(bytes)
          },
          onError: (error) => this.fail(error, rejectReady),
          onClose: () => this.fail(new Error('Browser network route transport closed'), rejectReady)
        },
        {
          ...this.options.subscription,
          perMessageDeflate: false,
          outboundQueue: {
            softCapBytes: BROWSER_TUNNEL_WS_SOFT_CAP_BYTES,
            maxQueuedBytes: BROWSER_TUNNEL_WS_MAX_QUEUED_BYTES,
            maxQueuedFrames: 2_048,
            maxDrainFramesPerTurn: 4
          },
          outboundMemoryBudget: this.options.outboundMemory,
          clientCapabilities: [
            ...(this.options.subscription?.clientCapabilities ?? []),
            BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
            BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
            ...(this.options.executionHost.kind === 'native'
              ? []
              : [BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY])
          ]
        }
      )
      if (this.closed) {
        subscription.close()
        throw new Error('Browser network route closed during startup')
      }
      this.subscription = subscription
      readyTimeout = setTimeout(
        () =>
          this.fail(
            new RemoteRuntimeClientError('runtime_timeout', 'Browser tunnel attach timed out.'),
            rejectReady
          ),
        this.options.timeoutMs
      )
      await ready
      if (this.closed || !this.tunnelValue) {
        throw new Error('Browser network route transport was not retained')
      }
      return this.tunnelValue
    } catch (error) {
      const transportError = asError(error)
      if (!this.closed) {
        this.fail(transportError, rejectReady)
      }
      throw transportError
    } finally {
      if (readyTimeout) {
        clearTimeout(readyTimeout)
      }
      this.rejectReady = null
    }
  }

  private acceptReady(
    tunnelGeneration: number,
    resolveReady: () => void,
    rejectReady: (error: Error) => void
  ): void {
    if (this.tunnelValue) {
      if (this.tunnelValue.generation !== tunnelGeneration) {
        this.fail(new Error('Browser network route generation changed in place'), rejectReady)
      }
      return
    }
    if (tunnelGeneration <= this.options.minimumTunnelGeneration) {
      this.fail(new Error('Browser network route generation did not advance'), rejectReady)
      return
    }
    try {
      this.tunnelValue = new BrowserNetworkTunnelClient({
        tunnelGeneration,
        sendBinary: (bytes) => this.subscription?.sendBinary(bytes) ?? false,
        outboundMemory: this.options.outboundMemory,
        maxStreamIds: this.options.maxStreamIds,
        onClosed: (error) => this.fail(error, rejectReady)
      })
      this.options.onReady(this, tunnelGeneration)
      resolveReady()
    } catch (error) {
      this.fail(asError(error), rejectReady)
    }
  }

  private fail(error: Error, rejectReady: (error: Error) => void): void {
    if (this.closed) {
      return
    }
    rejectReady(error)
    const cleanupFailures = this.close(error)
    try {
      this.options.onFailure(this, error, cleanupFailures)
    } catch {
      // Route failure reporting cannot retain a failed transport.
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
