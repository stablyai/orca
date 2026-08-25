import type {
  BrowserHostLeaseAuthority,
  BrowserNetworkExecutionHost
} from '../../shared/browser-client-host-protocol'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import type { PairingOffer } from '../../shared/pairing'
import type { RemoteRuntimeSubscriptionOptions } from '../../shared/remote-runtime-client'
import { resolveBrowserHostReconnectDelay } from './browser-host-lease-reconnect-delay'
import { retryBrowserNetworkRouteReconnect } from './browser-network-route-reconnect-retry'
import {
  BrowserNetworkTunnelOutboundMemoryBudgetRegistry,
  type BrowserNetworkTunnelOutboundMemoryLease
} from './browser-network-tunnel-outbound-memory-budget'
import { PairedRuntimeBrowserNetworkTransport } from './paired-runtime-browser-network-transport'
import { RemoteBrowserSocksServer } from './remote-browser-socks-server'

const outboundMemoryBudgets = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry()

type PairedRuntimeBrowserNetworkRouteOptions = {
  pairing: PairingOffer
  lease: BrowserHostLeaseAuthority
  executionHostRevision: number
  executionHost?: BrowserNetworkExecutionHost
  timeoutMs?: number
  subscription?: RemoteRuntimeSubscriptionOptions
  outboundMemoryBudgetRegistry?: BrowserNetworkTunnelOutboundMemoryBudgetRegistry
  maxStreamIdsPerTunnel?: number
  recoveryGraceMs?: number
  recoveryRetryDelayMs?: number
  onError?: (error: Error) => void
  /** The route stayed dark after bounded recovery; its pages cannot reach the network. */
  onUnavailable?: (error: Error) => void
}

type BrowserNetworkRouteAddress = { host: string; port: number }

export class PairedRuntimeBrowserNetworkRoute {
  private readonly options: PairedRuntimeBrowserNetworkRouteOptions
  private readonly socks: RemoteBrowserSocksServer
  private transport: PairedRuntimeBrowserNetworkTransport | null = null
  private outboundMemory: BrowserNetworkTunnelOutboundMemoryLease | null = null
  private startPromise: Promise<BrowserNetworkRouteAddress> | null = null
  private reconnectPromise: Promise<BrowserNetworkRouteAddress> | null = null
  private closePromise: Promise<void> | null = null
  private address: BrowserNetworkRouteAddress | null = null
  private recovery: { abort: AbortController; promise: Promise<void> } | null = null
  private readonly recoveryGraceMs: number
  private readonly recoveryRetryDelayMs: number
  private lastTunnelGeneration = 0
  private started = false
  private closed = false

  constructor(options: PairedRuntimeBrowserNetworkRouteOptions) {
    this.options = options
    this.recoveryGraceMs = resolveBrowserHostReconnectDelay(options.recoveryGraceMs, 15_000)
    this.recoveryRetryDelayMs = resolveBrowserHostReconnectDelay(options.recoveryRetryDelayMs)
    this.socks = new RemoteBrowserSocksServer({
      open: (target) => this.openTarget(target)
    })
  }

  start(): Promise<BrowserNetworkRouteAddress> {
    if (this.closed) {
      return Promise.reject(new Error('Browser network route is closed'))
    }
    this.startPromise ??= this.startRoute()
    return this.startPromise
  }

  reconnect(): Promise<BrowserNetworkRouteAddress> {
    if (this.closed) {
      return Promise.reject(new Error('Browser network route is closed'))
    }
    if (!this.started) {
      return this.start()
    }
    if (this.transport?.tunnel && this.address) {
      return Promise.resolve(this.address)
    }
    return this.beginReconnect()
  }

  suspend(error = new Error('Browser network route transport suspended')): void {
    if (this.closed) {
      return
    }
    this.cancelRecovery()
    const transport = this.transport
    this.transport = null
    this.reconnectPromise = null
    for (const failure of transport?.close(error) ?? []) {
      this.reportError(failure)
    }
  }

  async close(error = new Error('Browser network route is closed')): Promise<void> {
    if (this.closePromise) {
      return this.closePromise
    }
    this.closed = true
    this.cancelRecovery()
    this.closePromise = this.closeRoute(error)
    return this.closePromise
  }

  private async startRoute(): Promise<BrowserNetworkRouteAddress> {
    try {
      this.outboundMemory = (
        this.options.outboundMemoryBudgetRegistry ?? outboundMemoryBudgets
      ).acquire(this.options.lease.browserHostClientId)
      if (!this.outboundMemory) {
        throw new Error('Browser network route outbound memory admission failed')
      }
      await this.connectTransport()
      const address = await this.socks.listen()
      if (this.closed || !this.transport?.tunnel) {
        throw new Error('Browser network route closed during startup')
      }
      this.address = address
      this.started = true
      return address
    } catch (error) {
      const routeError = asError(error)
      try {
        await this.close(routeError)
      } catch (closeError) {
        throw new AggregateError(
          [routeError, closeError],
          'Browser network route startup cleanup failed'
        )
      }
      throw routeError
    }
  }

  private async connectTransport(): Promise<void> {
    const outboundMemory = this.outboundMemory
    if (!outboundMemory) {
      throw new Error('Browser network route memory lease is unavailable')
    }
    const transport = new PairedRuntimeBrowserNetworkTransport({
      pairing: this.options.pairing,
      lease: this.options.lease,
      executionHost: this.options.executionHost ?? {
        kind: 'native',
        runtimeId: this.options.lease.authorityRuntimeId,
        revision: this.options.executionHostRevision
      },
      timeoutMs: this.options.timeoutMs ?? 15_000,
      subscription: this.options.subscription,
      outboundMemory,
      maxStreamIds: this.options.maxStreamIdsPerTunnel,
      minimumTunnelGeneration: this.lastTunnelGeneration,
      onReady: (readyTransport, generation) => {
        if (this.transport === readyTransport) {
          this.lastTunnelGeneration = Math.max(this.lastTunnelGeneration, generation)
        }
      },
      onFailure: (failed, error, cleanupFailures) =>
        this.handleTransportFailure(failed, error, cleanupFailures)
    })
    this.transport = transport
    const tunnel = await transport.start()
    if (this.closed || this.transport !== transport) {
      for (const failure of transport.close(new Error('Browser network transport superseded'))) {
        this.reportError(failure)
      }
      throw new Error('Browser network route transport was superseded')
    }
    this.lastTunnelGeneration = Math.max(this.lastTunnelGeneration, tunnel.generation)
  }

  private beginReconnect(): Promise<BrowserNetworkRouteAddress> {
    if (this.reconnectPromise) {
      return this.reconnectPromise
    }
    const address = this.address
    if (!address) {
      return Promise.reject(new Error('Browser network route listener is not ready'))
    }
    const reconnecting = this.connectTransport()
      .then(() => {
        if (this.closed || !this.transport?.tunnel) {
          throw new Error('Browser network route reconnect was not retained')
        }
        return address
      })
      .finally(() => {
        if (this.reconnectPromise === reconnecting) {
          this.reconnectPromise = null
        }
      })
    this.reconnectPromise = reconnecting
    return reconnecting
  }

  private replaceExhaustedTransport(): Promise<BrowserNetworkRouteAddress> {
    if (this.reconnectPromise) {
      return this.reconnectPromise
    }
    const transport = this.transport
    this.transport = null
    for (const failure of transport?.close(
      new Error('Browser network route stream IDs exhausted')
    ) ?? []) {
      this.reportError(failure)
    }
    return this.beginReconnect()
  }

  private async openTarget(target: BrowserNetworkTunnelOpen) {
    let tunnel = this.requireTunnel()
    if (tunnel.streamIdsExhausted) {
      await this.replaceExhaustedTransport()
      tunnel = this.requireTunnel()
    }
    return tunnel.open(target)
  }

  private handleTransportFailure(
    transport: PairedRuntimeBrowserNetworkTransport,
    error: Error,
    cleanupFailures: Error[]
  ): void {
    if (this.transport !== transport) {
      return
    }
    this.transport = null
    this.reportError(error)
    for (const failure of cleanupFailures) {
      this.reportError(failure)
    }
    this.beginRecovery(error)
  }

  /**
   * The tunnel attaches on its own subscription, so a tunnel-only death is invisible to the
   * client-host channel that drives registry-level suspend/reconnect. Without a rebuild here the
   * route stays dark and every page request fails until an unrelated retain happens to revive it.
   */
  private beginRecovery(error: Error): void {
    if (this.closed || !this.started || this.recovery) {
      return
    }
    const abort = new AbortController()
    // Assigned before the first attempt so a synchronous rebuild failure re-enters this guard.
    const recovery = { abort, promise: Promise.resolve() }
    this.recovery = recovery
    recovery.promise = retryBrowserNetworkRouteReconnect({
      reconnect: () => this.reconnect(),
      signal: abort.signal,
      deadline: Date.now() + this.recoveryGraceMs,
      retryDelayMs: this.recoveryRetryDelayMs,
      recoveryKey: `${this.options.lease.browserHostClientId}:transport`
    })
      .then(
        () => undefined,
        (recoveryError: unknown) => {
          if (!abort.signal.aborted && !this.closed) {
            this.reportUnavailable(asError(recoveryError), error)
          }
        }
      )
      .finally(() => {
        if (this.recovery === recovery) {
          this.recovery = null
        }
      })
  }

  private cancelRecovery(): void {
    this.recovery?.abort.abort()
    this.recovery = null
  }

  private reportUnavailable(recoveryError: Error, transportError: Error): void {
    const unavailable = new AggregateError(
      [transportError, recoveryError],
      `Browser network route transport closed and could not be rebuilt: ${transportError.message}`
    )
    if (!this.options.onUnavailable) {
      this.reportError(unavailable)
      return
    }
    try {
      this.options.onUnavailable(unavailable)
    } catch {
      // A reporting callback cannot keep a dead route alive.
    }
  }

  private async closeRoute(error: Error): Promise<void> {
    const failures = this.transport?.close(error) ?? []
    this.transport = null
    this.outboundMemory?.release()
    this.outboundMemory = null
    try {
      await this.socks.close()
    } catch (closeError) {
      failures.push(asError(closeError))
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

  private requireTunnel() {
    const tunnel = this.transport?.tunnel
    if (!tunnel) {
      throw new Error('Browser network route is not ready')
    }
    return tunnel
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
