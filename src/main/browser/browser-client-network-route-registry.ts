import type {
  BrowserHostLeaseAuthority,
  BrowserNetworkExecutionHost
} from '../../shared/browser-client-host-protocol'
import type { BrowserClientPageNetworkRoute } from './browser-client-page-cleanup'
import {
  assertBrowserClientNetworkRouteAddress,
  sameBrowserClientNetworkRouteAddress
} from './browser-client-network-route-address'
import { reconnectBrowserClientNetworkRoutes } from './browser-client-network-route-recovery'
import {
  browserNetworkExecutionHostStorageIdentity,
  legacyBrowserNetworkExecutionHostStorageIdentity
} from './browser-execution-host-storage-identity'
import { createRouteRetirement, waitForRoute } from './browser-client-network-route-settlement'
import { resolveBrowserHostReconnectDelay } from './browser-host-lease-reconnect-delay'
import { parseBrowserNetworkExecutionHostKey } from './browser-network-execution-route'

type BrowserClientNetworkRoute = {
  start(): Promise<{ host: string; port: number }>
  reconnect(): Promise<{ host: string; port: number }>
  suspend(error?: Error): void
  close(error?: Error): Promise<void>
}

type BrowserClientNetworkRouteRegistryOptions = {
  authority: BrowserHostLeaseAuthority
  /** Durable name for the authority's machine; its runtimeId is per-process and must not reach storage. */
  authorityStorageKey: string
  reconnectGraceMs?: number
  reconnectRetryDelayMs?: number
  createRoute(
    executionHost: BrowserNetworkExecutionHost,
    authority: BrowserHostLeaseAuthority
  ): BrowserClientNetworkRoute
}

type RetainedRoute = {
  key: string
  route: BrowserClientNetworkRoute
  references: number
  address?: { host: string; port: number }
  /** Set while teardown runs; cleared only when the teardown outcome is unknown. */
  closing?: Promise<void>
}

export class BrowserClientNetworkRouteRegistry {
  private readonly routes = new Map<string, RetainedRoute>()
  private closePromise: Promise<void> | null = null
  private recoveryGeneration = 0
  private recovery: { generation: number; abort: AbortController; promise: Promise<void> } | null =
    null
  private retirement: ReturnType<typeof createRouteRetirement> | null = null
  private readonly reconnectGraceMs: number
  private readonly reconnectRetryDelayMs: number
  private suspended = false
  private closed = false

  constructor(private readonly options: BrowserClientNetworkRouteRegistryOptions) {
    this.reconnectGraceMs = resolveBrowserHostReconnectDelay(options.reconnectGraceMs, 15_000)
    this.reconnectRetryDelayMs = resolveBrowserHostReconnectDelay(options.reconnectRetryDelayMs)
  }

  async retain(key: string, signal: AbortSignal): Promise<BrowserClientPageNetworkRoute> {
    this.assertAdmission(signal)
    const executionHost = parseBrowserNetworkExecutionHostKey(key)
    if (
      (executionHost.kind === 'native' || executionHost.kind === 'wsl') &&
      executionHost.runtimeId !== this.options.authority.authorityRuntimeId
    ) {
      throw new Error('browser_client_network_route_authority_mismatch')
    }
    await this.settleClosingRoute(key, signal)
    let retained = this.routes.get(key)
    const existing = retained !== undefined
    if (!retained) {
      retained = {
        key,
        route: this.options.createRoute(executionHost, this.options.authority),
        references: 0
      }
      this.routes.set(key, retained)
    }
    retained.references += 1
    try {
      const address = await waitForRoute(
        existing ? retained.route.reconnect() : retained.route.start(),
        signal
      )
      this.assertAdmission(signal)
      assertBrowserClientNetworkRouteAddress(address)
      if (retained.address && !sameBrowserClientNetworkRouteAddress(retained.address, address)) {
        throw new Error('browser_client_network_route_address_changed')
      }
      retained.address = address
      let released = false
      return {
        key,
        // Why: the route key fences per-boot generations; storage must outlive them.
        executionHostIdentity: browserNetworkExecutionHostStorageIdentity(
          executionHost,
          this.options.authorityStorageKey
        ),
        legacyExecutionHostIdentity:
          legacyBrowserNetworkExecutionHostStorageIdentity(executionHost),
        proxyEndpoint: { host: '127.0.0.1', port: address.port },
        release: async () => {
          if (released) {
            return
          }
          released = true
          await this.release(retained)
        }
      }
    } catch (error) {
      await this.releaseAfterFailedRetain(retained, error)
      throw error
    }
  }

  close(error = new Error('Browser client network route registry is closed')): Promise<void> {
    this.closed = true
    this.recovery?.abort.abort()
    this.recovery = null
    this.closePromise ??= this.closeRoutes(error)
    return this.closePromise
  }

  retire(error = new Error('Browser client network route registry is retired')): Promise<void> {
    if (this.closed) {
      return this.closePromise ?? Promise.resolve()
    }
    const retirement = (this.retirement ??= createRouteRetirement())
    if (!this.suspended) {
      try {
        this.suspend(error)
      } catch (suspensionError) {
        retirement.reject(suspensionError)
        throw suspensionError
      }
    }
    this.settleRetirement()
    return retirement.promise
  }

  suspend(error = new Error('Browser client network routes suspended')): void {
    if (this.closed) {
      return
    }
    this.suspended = true
    this.recovery?.abort.abort()
    this.recovery = null
    this.recoveryGeneration += 1
    const failures: unknown[] = []
    for (const retained of this.routes.values()) {
      try {
        retained.route.suspend(error)
      } catch (failure) {
        failures.push(failure)
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Browser client network route suspension failed')
    }
  }

  reconnect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('browser_client_network_route_registry_closed'))
    }
    if (this.retirement) {
      return Promise.reject(new Error('browser_client_network_route_registry_retired'))
    }
    if (!this.suspended) {
      return Promise.resolve()
    }
    const existing = this.recovery
    if (existing?.generation === this.recoveryGeneration) {
      return existing.promise
    }
    const generation = this.recoveryGeneration
    const abort = new AbortController()
    const recovering = this.reconnectRoutes(generation, abort.signal).finally(() => {
      if (this.recovery?.promise === recovering) {
        this.recovery = null
      }
    })
    this.recovery = { generation, abort, promise: recovering }
    return recovering
  }

  private async reconnectRoutes(generation: number, signal: AbortSignal): Promise<void> {
    const retained = [...this.routes.values()]
    const addresses = await reconnectBrowserClientNetworkRoutes({
      routes: retained,
      signal,
      graceMs: this.reconnectGraceMs,
      retryDelayMs: this.reconnectRetryDelayMs,
      browserHostClientId: this.options.authority.browserHostClientId
    })
    for (const [index, address] of addresses.entries()) {
      assertBrowserClientNetworkRouteAddress(address)
      const previous = retained[index]?.address
      if (previous && !sameBrowserClientNetworkRouteAddress(previous, address)) {
        throw new Error('browser_client_network_route_address_changed')
      }
    }
    if (!this.closed && this.recoveryGeneration === generation) {
      this.suspended = false
    }
  }

  private assertAdmission(signal: AbortSignal): void {
    if (this.closed) {
      throw new Error('browser_client_network_route_registry_closed')
    }
    if (this.retirement) {
      throw new Error('browser_client_network_route_registry_retired')
    }
    if (this.suspended) {
      throw new Error('browser_client_network_route_registry_suspended')
    }
    if (signal.aborted) {
      throw new Error('browser_client_network_route_aborted')
    }
  }

  /** A closing route can never be revived, so a retain waits it out and then mints a fresh one. */
  private async settleClosingRoute(key: string, signal: AbortSignal): Promise<void> {
    let closing = this.routes.get(key)?.closing
    while (closing) {
      await waitForRoute(closing, signal)
      this.assertAdmission(signal)
      closing = this.routes.get(key)?.closing
    }
  }

  private async release(retained: RetainedRoute): Promise<void> {
    if (retained.references < 1) {
      return
    }
    retained.references -= 1
    if (retained.references !== 0 || this.routes.get(retained.key) !== retained) {
      return
    }
    const closing = retained.route.close()
    retained.closing = closing
    try {
      await closing
    } catch (error) {
      // Why: an unprovable teardown keeps the closed route in place so the key stays fenced.
      retained.closing = undefined
      throw error
    }
    if (this.routes.get(retained.key) === retained) {
      this.routes.delete(retained.key)
    }
    this.settleRetirement()
  }

  private async releaseAfterFailedRetain(retained: RetainedRoute, error: unknown): Promise<void> {
    try {
      await this.release(retained)
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        error instanceof Error ? error.message : 'browser_client_network_route_retain_failed'
      )
    }
  }

  private async closeRoutes(error: Error): Promise<void> {
    const retained = [...this.routes.values()]
    this.routes.clear()
    const results = await Promise.allSettled(retained.map((entry) => entry.route.close(error)))
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : []
    )
    if (failures.length > 0) {
      this.retirement?.reject(
        new AggregateError(failures, 'Browser client network route cleanup failed')
      )
      throw new AggregateError(failures, 'Browser client network route cleanup failed')
    }
    this.settleRetirement()
  }

  private settleRetirement(): void {
    if (this.retirement && this.routes.size === 0) {
      this.retirement.resolve()
    }
  }
}
