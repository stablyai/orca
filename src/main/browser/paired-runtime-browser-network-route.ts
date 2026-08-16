import type { PairingOffer } from '../../shared/pairing'
import {
  BrowserNetworkTunnelEvent,
  type BrowserHostLeaseAuthority
} from '../../shared/browser-client-host-protocol'
import {
  subscribeRemoteRuntimeRequest,
  type RemoteRuntimeSubscription,
  type RemoteRuntimeSubscriptionOptions
} from '../../shared/remote-runtime-client'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import { BrowserNetworkTunnelClient } from './browser-network-tunnel-client'
import {
  BrowserNetworkTunnelOutboundMemoryBudgetRegistry,
  type BrowserNetworkTunnelOutboundMemoryLease
} from './browser-network-tunnel-outbound-memory-budget'
import { RemoteBrowserSocksServer } from './remote-browser-socks-server'

const BROWSER_TUNNEL_WS_SOFT_CAP_BYTES = 1024 * 1024
const BROWSER_TUNNEL_WS_MAX_QUEUED_BYTES = 7 * 1024 * 1024
const outboundMemoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()

type PairedRuntimeBrowserNetworkRouteOptions = {
  pairing: PairingOffer
  lease: BrowserHostLeaseAuthority
  executionHostRevision: number
  timeoutMs?: number
  subscription?: RemoteRuntimeSubscriptionOptions
  outboundMemoryBudgetRegistry?: BrowserNetworkTunnelOutboundMemoryBudgetRegistry
  onError?: (error: Error) => void
}

export class PairedRuntimeBrowserNetworkRoute {
  private readonly options: PairedRuntimeBrowserNetworkRouteOptions
  private tunnel: BrowserNetworkTunnelClient | null = null
  private readonly socks: RemoteBrowserSocksServer
  private subscription: RemoteRuntimeSubscription | null = null
  private outboundMemory: BrowserNetworkTunnelOutboundMemoryLease | null = null
  private startPromise: Promise<{ host: string; port: number }> | null = null
  private closePromise: Promise<void> | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private closed = false
  private ready = false

  constructor(options: PairedRuntimeBrowserNetworkRouteOptions) {
    this.options = options
    this.socks = new RemoteBrowserSocksServer({
      open: (target) => this.requireTunnel().open(target)
    })
  }

  start(): Promise<{ host: string; port: number }> {
    if (this.closed) {
      return Promise.reject(new Error('Browser network route is closed'))
    }
    this.startPromise ??= this.startRoute()
    return this.startPromise
  }

  async close(error = new Error('Browser network route is closed')): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.closed = true
    this.rejectReady?.(error)
    this.closePromise = this.closeRoute(error)
    return this.closePromise
  }

  private async startRoute(): Promise<{ host: string; port: number }> {
    const timeoutMs = this.options.timeoutMs ?? 15_000
    let resolveReady = (): void => {}
    let rejectReady = (_error: Error): void => {}
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    void ready.catch(() => undefined)
    let readyTimeout: ReturnType<typeof setTimeout> | null = null
    try {
      this.outboundMemory = (
        this.options.outboundMemoryBudgetRegistry ?? outboundMemoryBudgets
      ).acquire(this.options.lease.browserHostClientId)
      if (!this.outboundMemory) {
        throw new Error('Browser network route outbound memory admission failed')
      }
      const subscription = await subscribeRemoteRuntimeRequest(
        this.options.pairing,
        'network.browserTunnel',
        {
          ...this.options.lease,
          executionHost: {
            kind: 'native',
            runtimeId: this.options.lease.authorityRuntimeId,
            revision: this.options.executionHostRevision
          }
        },
        timeoutMs,
        {
          onResponse: (response) => {
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
              if (this.tunnel) {
                if (this.tunnel.generation !== result.tunnelGeneration) {
                  this.fail(
                    new Error('Browser network route generation changed in place'),
                    rejectReady
                  )
                }
                return
              }
              this.tunnel = new BrowserNetworkTunnelClient({
                tunnelGeneration: result.tunnelGeneration,
                sendBinary: (bytes) => this.subscription?.sendBinary(bytes) ?? false,
                outboundMemory: this.outboundMemory ?? undefined
              })
              this.ready = true
              resolveReady()
            } else if (this.tunnel?.generation === result.tunnelGeneration) {
              this.fail(new Error('Browser network route closed by the runtime'), rejectReady)
            } else {
              this.fail(
                new Error('Browser network route closed with an unknown generation'),
                rejectReady
              )
            }
          },
          onBinary: (bytes) => {
            if (!this.tunnel) {
              this.fail(
                new Error('Browser network route received binary data before readiness'),
                rejectReady
              )
              return
            }
            this.tunnel.handleBinary(bytes)
          },
          onError: (routeError) => this.fail(routeError, rejectReady),
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
          outboundMemoryBudget: this.outboundMemory,
          clientCapabilities: [
            ...(this.options.subscription?.clientCapabilities ?? []),
            BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
            BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
          ]
        }
      )
      if (this.closed) {
        subscription.close()
        throw new Error('Browser network route closed during startup')
      }
      this.subscription = subscription
      this.rejectReady = rejectReady
      readyTimeout = setTimeout(
        () =>
          rejectReady(
            new RemoteRuntimeClientError('runtime_timeout', 'Browser tunnel attach timed out.')
          ),
        timeoutMs
      )
      await ready
      if (this.closed) {
        throw new Error('Browser network route closed during startup')
      }
      const address = await this.socks.listen()
      if (this.closed) {
        throw new Error('Browser network route closed during startup')
      }
      return address
    } catch (error) {
      const routeError = error instanceof Error ? error : new Error(String(error))
      try {
        await this.close(routeError)
      } catch (closeError) {
        throw new AggregateError(
          [routeError, closeError],
          'Browser network route startup cleanup failed'
        )
      }
      throw routeError
    } finally {
      if (readyTimeout) {
        clearTimeout(readyTimeout)
      }
      this.rejectReady = null
    }
  }

  private fail(error: Error, rejectReady: (error: Error) => void): void {
    if (this.closed) {
      return
    }
    if (!this.ready) {
      rejectReady(error)
    }
    const closing = this.close(error)
    this.reportError(error)
    void closing.catch((closeError) =>
      this.reportError(closeError instanceof Error ? closeError : new Error(String(closeError)))
    )
  }

  private async closeRoute(error: Error): Promise<void> {
    const failures: Error[] = []
    try {
      this.tunnel?.close(error)
    } catch (closeError) {
      failures.push(closeError instanceof Error ? closeError : new Error(String(closeError)))
    }
    this.tunnel = null
    try {
      this.subscription?.close()
    } catch (closeError) {
      failures.push(closeError instanceof Error ? closeError : new Error(String(closeError)))
    }
    this.subscription = null
    this.outboundMemory?.release()
    this.outboundMemory = null
    try {
      await this.socks.close()
    } catch (closeError) {
      failures.push(closeError instanceof Error ? closeError : new Error(String(closeError)))
    }
    if (failures.length === 1) {
      throw failures[0]
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Browser network route cleanup failed')
    }
  }

  private reportError(error: Error): void {
    try {
      this.options.onError?.(error)
    } catch {
      // A reporting callback cannot prevent route cleanup.
    }
  }

  private requireTunnel(): BrowserNetworkTunnelClient {
    if (!this.tunnel) {
      throw new Error('Browser network route is not ready')
    }
    return this.tunnel
  }
}
