import type { BrowserClientProfileMetadata } from '../../../../shared/browser/client-hosting/browser-client-profile-switch-protocol'
const PROXY_PROBE_URL = 'http://browser-route-probe.invalid/'
const LOOPBACK_PROBE_URL = 'http://127.0.0.1/'

export type { BrowserClientHostViewer as BrowserRouteViewer } from '../../../../shared/browser/client-hosting/browser-client-host-placement'
import type { BrowserClientHostViewer as BrowserRouteViewer } from '../../../../shared/browser/client-hosting/browser-client-host-placement'

/**
 * The one choice of what a client-hosted page sends through its host. Your own computer: everything,
 * as before. A teammate: only loopback (the host's dev servers), the rest direct from this machine.
 * `*` bypasses everything, the later `<-loopback>` takes loopback and link-local back out of that
 * bypass, and the CIDRs return link-local to it, as in t3code's LoopbackTunnel.ts:586-599.
 */
export function browserRouteProxyBypassRules(viewer: BrowserRouteViewer): string {
  return viewer === 'teammate' ? '*,<-loopback>,169.254.0.0/16,fe80::/10' : '<-loopback>'
}

export type BrowserRouteElectronSession = {
  setProxy(config: {
    mode: 'fixed_servers'
    proxyRules: string
    proxyBypassRules: string
  }): Promise<void>
  closeAllConnections(): Promise<void>
  resolveProxy(url: string): Promise<string>
}

export type BrowserRouteProxyEndpoint = Readonly<{ host: '127.0.0.1'; port: number }>

type BrowserRouteSessionPolicyDependencies = {
  getSession(partition: string): BrowserRouteElectronSession
  setupPolicies(input: {
    profileMetadata?: BrowserClientProfileMetadata
    partition: string
    browserProfileId: string
    session: BrowserRouteElectronSession
    viewer: BrowserRouteViewer
  }): void | Promise<void>
  clearPolicies(input: { partition: string; session: BrowserRouteElectronSession }): void
}

export async function prepareBrowserRouteSessionPolicy(input: {
  profileMetadata?: BrowserClientProfileMetadata
  partition: string
  browserProfileId: string
  proxyEndpoint: BrowserRouteProxyEndpoint
  /** Absent: one of this user's own computers. */
  viewer?: BrowserRouteViewer
  dependencies: BrowserRouteSessionPolicyDependencies
}): Promise<BrowserRouteElectronSession> {
  const session = input.dependencies.getSession(input.partition)
  const viewer = input.viewer ?? 'own-computer'
  let proxySetup: Promise<void> | null = null
  try {
    proxySetup = session.setProxy({
      mode: 'fixed_servers',
      proxyRules: `socks5://${input.proxyEndpoint.host}:${input.proxyEndpoint.port}`,
      proxyBypassRules: browserRouteProxyBypassRules(viewer)
    })
    await input.dependencies.setupPolicies({
      ...(input.profileMetadata ? { profileMetadata: input.profileMetadata } : {}),
      partition: input.partition,
      browserProfileId: input.browserProfileId,
      session,
      viewer
    })
    await proxySetup
    await session.closeAllConnections()
    const socks = `SOCKS5 ${input.proxyEndpoint.host}:${input.proxyEndpoint.port}`
    const [loopback, other] = await Promise.all([
      session.resolveProxy(LOOPBACK_PROBE_URL),
      session.resolveProxy(PROXY_PROBE_URL)
    ])
    if (loopback.trim() !== socks || other.trim() !== (viewer === 'teammate' ? 'DIRECT' : socks)) {
      throw new Error('browser_route_partition_proxy_verification_failed')
    }
  } catch (error) {
    await proxySetup?.catch(() => {})
    try {
      await session.closeAllConnections()
    } catch {
      // The partition remains outside admission even when connection cleanup fails.
    }
    try {
      input.dependencies.clearPolicies({ partition: input.partition, session })
    } catch {
      // The partition remains outside the allowlist even if policy cleanup fails.
    }
    throw error
  }
  return session
}

export function assertBrowserRouteProxyEndpoint(
  endpoint: Readonly<{ host: string; port: number }>
): asserts endpoint is BrowserRouteProxyEndpoint {
  if (
    endpoint.host !== '127.0.0.1' ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65_535
  ) {
    throw new Error('browser_route_partition_proxy_invalid')
  }
}

export function sameBrowserRouteProxyEndpoint(
  left: BrowserRouteProxyEndpoint,
  right: BrowserRouteProxyEndpoint
): boolean {
  return left.host === right.host && left.port === right.port
}
