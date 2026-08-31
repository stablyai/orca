import type { Duplex } from 'node:stream'
import type { BrowserNetworkExecutionRouteResolver } from './browser-network-execution-route'
import type { BrowserNetworkTunnelOpen } from '../../shared/browser-network-tunnel-protocol'
import { openExecutionRouteSocketAsDuplex } from './execution-route-socket-duplex'
import { RemoteBrowserSocksServer } from './remote-browser-socks-server'

export type LocalSshBrowserRouteDependencies = {
  resolveExecutionRoute: BrowserNetworkExecutionRouteResolver
  getAuthority: (targetId: string) => { providerEpoch: string; connectionGeneration: number }
}

/**
 * Loopback SOCKS listener for a directly-connected SSH target, dialing through
 * the in-process SSH execution route — no pairing, no tunnel.
 *
 * The listener's port must stay stable for the lifetime of every partition
 * proxied at it, so the server outlives SSH reconnects: each dial lazily
 * re-resolves the execution route under the target's *current* authority, and
 * a dial while the target is disconnected or mid-rotation fails the SOCKS
 * request instead of ever falling back to a direct local connection.
 */
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

  /**
   * Classifies whether the SSH server permits TCP forwarding by dialing a
   * loopback port that is closed on any sane host: a channel-level refusal
   * proves forwarding is allowed, while the wire's ADMINISTRATIVELY_PROHIBITED
   * reason (AllowTcpForwarding no / PermitOpen) proves it is not. Anything
   * else — timeout, refused, unknown wording, non-ssh2 transports — reads as
   * ok: the probe exists to explain failures, never to block a setup that
   * might work, so misclassification must only ever be a missed explanation.
   */
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
      // Why: only the native/wsl resolvers read these; the ssh resolver fences
      // on the authority embedded in the execution host instead.
      runtimeId: 'local-ssh-browser-route',
      runtimeRevision: 0
    })
    if (this.closed) {
      void Promise.resolve(route.close()).catch(() => {})
      throw new Error('browser_local_route_closed')
    }
    this.executionRoute = route
    // Why: rotation aborts the route; dropping it here makes the next dial re-resolve.
    void route.whenInvalidated?.then(() => {
      if (this.executionRoute === route) {
        this.executionRoute = null
      }
      void Promise.resolve(route.close()).catch(() => {})
    })
    return route
  }
}

/** RFC 4254 SSH_OPEN_ADMINISTRATIVELY_PROHIBITED — what sshd sends for AllowTcpForwarding no / PermitOpen. */
const SSH_OPEN_ADMINISTRATIVELY_PROHIBITED = 1

/**
 * Trusts the wire's numeric reason code first (ssh2 attaches it as `reason`;
 * every RFC 4254 server sends it, wording-independent). The exact OpenSSH
 * phrase is a fallback for errors that lost the code in transit. Broad word
 * matching ("denied", "forbidden") is deliberately absent — a firewall's
 * connect-failure text must never read as a policy block.
 */
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

/** One listener per SSH target for the app session; the port never moves under its partitions. */
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

/** Probe the retained route for a target; the route must have been retained first. */
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
