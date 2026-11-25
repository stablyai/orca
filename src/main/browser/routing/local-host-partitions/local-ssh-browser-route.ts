import type { Duplex } from 'node:stream'
import type { BrowserNetworkExecutionRouteResolver } from '../../network/execution-routes/browser-network-execution-route-contract'
import type { BrowserNetworkTunnelOpen } from '../../../../shared/browser/network/tunnels/browser-network-tunnel-protocol'
import type { SshTargetSummary } from '../../../../shared/remote-runtime/ssh/ssh-types'
import { openExecutionRouteSocketAsDuplex } from '../../network/tunnels/execution-route-socket-duplex'
import { RemoteBrowserSocksServer } from '../../network/tunnels/remote-browser-socks-server'

/** Any registered target may carry a route, including the runtime-owned ones recipes connect. */
export function requireLocalSshBrowserRouteTarget(
  target: Pick<SshTargetSummary, 'generation'> | undefined,
  expectedGeneration?: unknown
): void {
  if (!target) {
    throw new Error('browser_local_route_target_invalid')
  }
  if (
    expectedGeneration !== undefined &&
    (typeof expectedGeneration !== 'number' || target.generation !== expectedGeneration)
  ) {
    throw new Error('browser_local_route_target_stale')
  }
}

export type LocalSshBrowserRouteDependencies = {
  resolveExecutionRoute: BrowserNetworkExecutionRouteResolver
  getAuthority: (targetId: string) => { providerEpoch: string; connectionGeneration: number }
}

// Keep the SOCKS port stable across SSH reconnects for sessions already proxied through it.
export class LocalSshBrowserRoute {
  private readonly socks: RemoteBrowserSocksServer
  private executionRoute: Awaited<ReturnType<BrowserNetworkExecutionRouteResolver>> | null = null
  private routePromise: Promise<Awaited<ReturnType<BrowserNetworkExecutionRouteResolver>>> | null =
    null
  private listenPromise: Promise<{ host: string; port: number }> | null = null
  // Cancels a route still being resolved, such as a host relay being installed.
  private readonly closing = new AbortController()
  private closed = false

  constructor(
    private readonly targetId: string,
    private readonly dependencies: LocalSshBrowserRouteDependencies
  ) {
    this.socks = new RemoteBrowserSocksServer({
      open: (target) => this.openTarget(target)
    })
  }

  listen(): Promise<{ host: string; port: number }> {
    if (this.closed) {
      return Promise.reject(new Error('browser_local_route_closed'))
    }
    this.listenPromise ??= this.socks.listen()
    return this.listenPromise
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.closing.abort()
    const route = this.executionRoute
    this.executionRoute = null
    await Promise.all([this.socks.close(), route ? route.close() : Promise.resolve()])
  }

  private async openTarget(target: BrowserNetworkTunnelOpen): Promise<Duplex> {
    const route = await this.requireExecutionRoute()
    return openExecutionRouteSocketAsDuplex(route.connect(target))
  }

  /** Resolving the route probes the host's forwarding policy and starts a relay where forwarding stops at loopback. */
  async probeForwarding(): Promise<'ok' | 'forwarding-blocked' | 'ssh-unavailable'> {
    let route: Awaited<ReturnType<BrowserNetworkExecutionRouteResolver>>
    try {
      // A host that refused forwarding may run the relay now (Node installed, a session slot free).
      if (this.executionRoute?.forwardingBlocked) {
        this.retireExecutionRoute()
      }
      route = await this.requireExecutionRoute()
    } catch {
      return 'ssh-unavailable'
    }
    return route.forwardingBlocked ? 'forwarding-blocked' : 'ok'
  }

  private async requireExecutionRoute(): Promise<
    Awaited<ReturnType<BrowserNetworkExecutionRouteResolver>>
  > {
    if (this.closed) {
      throw new Error('browser_local_route_closed')
    }
    const current = this.executionRoute
    if (current?.isValid()) {
      return current
    }
    this.routePromise ??= this.resolveFreshRoute().finally(() => {
      this.routePromise = null
    })
    return this.routePromise
  }

  private retireExecutionRoute(): void {
    const stale = this.executionRoute
    this.executionRoute = null
    if (stale) {
      void Promise.resolve(stale.close()).catch(() => {})
    }
  }

  private async resolveFreshRoute(): Promise<
    Awaited<ReturnType<BrowserNetworkExecutionRouteResolver>>
  > {
    this.retireExecutionRoute()
    const authority = this.dependencies.getAuthority(this.targetId)
    const route = await this.dependencies.resolveExecutionRoute({
      executionHost: {
        kind: 'ssh',
        targetId: this.targetId,
        providerEpoch: authority.providerEpoch,
        connectionGeneration: authority.connectionGeneration
      },
      // SSH uses executionHost authority; runtimeId and runtimeRevision apply only to native/WSL.
      runtimeId: 'local-ssh-browser-route',
      runtimeRevision: 0,
      signal: this.closing.signal
    })
    if (this.closed) {
      void Promise.resolve(route.close()).catch(() => {})
      throw new Error('browser_local_route_closed')
    }
    this.executionRoute = route
    void route.whenInvalidated?.then(() => {
      if (this.executionRoute === route) {
        this.executionRoute = null
      }
      void Promise.resolve(route.close()).catch(() => {})
    })
    return route
  }
}

const routesByTargetId = new Map<string, LocalSshBrowserRoute>()

async function defaultDependencies(): Promise<LocalSshBrowserRouteDependencies> {
  const [{ resolveBrowserNetworkExecutionRoute }, authority] = await Promise.all([
    import('../../network/execution-routes/browser-network-execution-route-dispatch'),
    import('../../../ssh/connection/authority/ssh-provider-authority')
  ])
  return {
    resolveExecutionRoute: resolveBrowserNetworkExecutionRoute,
    getAuthority: (targetId) => authority.getSshProviderAuthority(targetId)
  }
}

export async function retainLocalSshBrowserRoute(
  targetId: string,
  dependencies?: LocalSshBrowserRouteDependencies
): Promise<{ host: '127.0.0.1'; port: number }> {
  let route = routesByTargetId.get(targetId)
  if (!route) {
    route = new LocalSshBrowserRoute(targetId, dependencies ?? (await defaultDependencies()))
    routesByTargetId.set(targetId, route)
  }
  try {
    const address = await route.listen()
    return { host: '127.0.0.1', port: address.port }
  } catch (error) {
    if (routesByTargetId.get(targetId) === route) {
      routesByTargetId.delete(targetId)
    }
    void route.close().catch(() => {})
    throw error
  }
}

export async function probeLocalSshBrowserRouteForwarding(
  targetId: string
): Promise<'ok' | 'forwarding-blocked' | 'ssh-unavailable'> {
  const route = routesByTargetId.get(targetId)
  if (!route) {
    return 'ssh-unavailable'
  }
  return route.probeForwarding()
}

export async function closeLocalSshBrowserRouteForTarget(targetId: string): Promise<void> {
  const route = routesByTargetId.get(targetId)
  if (!route) {
    return
  }
  routesByTargetId.delete(targetId)
  await route.close()
}

export async function closeAllLocalSshBrowserRoutes(): Promise<void> {
  const routes = [...routesByTargetId.values()]
  routesByTargetId.clear()
  await Promise.all(routes.map((route) => route.close().catch(() => {})))
}
