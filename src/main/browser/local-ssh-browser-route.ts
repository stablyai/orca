import type { Duplex } from 'node:stream'
import type { BrowserNetworkExecutionRouteResolver } from './browser-network-execution-route'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import type { SshTargetSummary } from '../../shared/ssh-types'
import { openExecutionRouteSocketAsDuplex } from './execution-route-socket-duplex'
import { RemoteBrowserSocksServer } from './remote-browser-socks-server'

export function requireLocalSshBrowserRouteTarget(
  targets: readonly Pick<SshTargetSummary, 'id' | 'generation'>[] | undefined,
  targetId: string,
  expectedGeneration?: unknown
): void {
  const target = targets?.find((entry) => entry.id === targetId)
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
    const route = this.executionRoute
    this.executionRoute = null
    await Promise.all([this.socks.close(), route ? route.close() : Promise.resolve()])
  }

  private async openTarget(target: BrowserNetworkTunnelOpen): Promise<Duplex> {
    const route = await this.requireExecutionRoute()
    return openExecutionRouteSocketAsDuplex(route.connect(target))
  }

  // Destination failures are inconclusive: port 9 may be closed even when forwarding is allowed.
  async probeForwarding(
    timeoutMs = 4_000
  ): Promise<'ok' | 'forwarding-blocked' | 'ssh-unavailable'> {
    let route: Awaited<ReturnType<BrowserNetworkExecutionRouteResolver>>
    try {
      route = await this.requireExecutionRoute()
    } catch {
      return 'ssh-unavailable'
    }
    const socket = route.connect({ host: '127.0.0.1', port: 9 })
    return new Promise((resolve) => {
      let settled = false
      const settle = (verdict: 'ok' | 'forwarding-blocked' | 'ssh-unavailable'): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timeout)
        socket.destroy()
        resolve(verdict)
      }
      const timeout = setTimeout(() => settle('ok'), timeoutMs)
      socket.on('connect', () => settle('ok'))
      socket.on('error', (error) =>
        settle(isAdministrativelyProhibited(error) ? 'forwarding-blocked' : 'ok')
      )
      socket.on('close', () => settle('ok'))
    })
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

  private async resolveFreshRoute(): Promise<
    Awaited<ReturnType<BrowserNetworkExecutionRouteResolver>>
  > {
    const stale = this.executionRoute
    this.executionRoute = null
    if (stale) {
      void Promise.resolve(stale.close()).catch(() => {})
    }
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
      runtimeRevision: 0
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

const SSH_OPEN_ADMINISTRATIVELY_PROHIBITED = 1

// Prefer numeric SSH reasons; broad text matching could mistake destination refusal for policy denial.
function isAdministrativelyProhibited(error: Error): boolean {
  const reason = (error as Error & { reason?: unknown }).reason
  if (typeof reason === 'number') {
    return reason === SSH_OPEN_ADMINISTRATIVELY_PROHIBITED
  }
  return /administratively prohibited/i.test(error.message)
}

const routesByTargetId = new Map<string, LocalSshBrowserRoute>()

async function defaultDependencies(): Promise<LocalSshBrowserRouteDependencies> {
  const [{ resolveBrowserNetworkExecutionRoute }, authority] = await Promise.all([
    import('./browser-network-execution-route-dispatch'),
    import('../ssh/ssh-provider-authority')
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
