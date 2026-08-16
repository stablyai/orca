import type {
  BrowserHostLeaseAuthority,
  BrowserNetworkExecutionHost
} from '../../shared/browser-client-host-protocol'
import type { BrowserClientPageNetworkRoute } from './browser-client-page-cleanup'
import { parseBrowserNetworkExecutionHostKey } from './browser-network-execution-route'

type BrowserClientNetworkRoute = {
  start(): Promise<{ host: string; port: number }>
  reconnect(): Promise<{ host: string; port: number }>
  close(error?: Error): Promise<void>
}

type BrowserClientNetworkRouteRegistryOptions = {
  authority: BrowserHostLeaseAuthority
  createRoute(
    executionHost: BrowserNetworkExecutionHost,
    authority: BrowserHostLeaseAuthority
  ): BrowserClientNetworkRoute
}

type RetainedRoute = {
  key: string
  route: BrowserClientNetworkRoute
  references: number
}

export class BrowserClientNetworkRouteRegistry {
  private readonly routes = new Map<string, RetainedRoute>()
  private closePromise: Promise<void> | null = null
  private closed = false

  constructor(private readonly options: BrowserClientNetworkRouteRegistryOptions) {}

  async retain(key: string, signal: AbortSignal): Promise<BrowserClientPageNetworkRoute> {
    this.assertAdmission(signal)
    const executionHost = parseBrowserNetworkExecutionHostKey(key)
    if (
      executionHost.kind === 'native' &&
      executionHost.runtimeId !== this.options.authority.authorityRuntimeId
    ) {
      throw new Error('browser_client_network_route_authority_mismatch')
    }
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
      const address = await waitForRouteAddress(
        existing ? retained.route.reconnect() : retained.route.start(),
        signal
      )
      this.assertAdmission(signal)
      if (
        address.host !== '127.0.0.1' ||
        !Number.isInteger(address.port) ||
        address.port < 1 ||
        address.port > 65_535
      ) {
        throw new Error('browser_client_network_route_address_invalid')
      }
      let released = false
      return {
        key,
        executionHostIdentity: key,
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
    this.closePromise ??= this.closeRoutes(error)
    return this.closePromise
  }

  private assertAdmission(signal: AbortSignal): void {
    if (this.closed) {
      throw new Error('browser_client_network_route_registry_closed')
    }
    if (signal.aborted) {
      throw new Error('browser_client_network_route_aborted')
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
    this.routes.delete(retained.key)
    await retained.route.close()
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
      throw new AggregateError(failures, 'Browser client network route cleanup failed')
    }
  }
}

function waitForRouteAddress(
  route: Promise<{ host: string; port: number }>,
  signal: AbortSignal
): Promise<{ host: string; port: number }> {
  if (signal.aborted) {
    return Promise.reject(new Error('browser_client_network_route_aborted'))
  }
  return new Promise((resolve, reject) => {
    const abort = (): void => reject(new Error('browser_client_network_route_aborted'))
    signal.addEventListener('abort', abort, { once: true })
    void route.then(
      (address) => {
        signal.removeEventListener('abort', abort)
        resolve(address)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
