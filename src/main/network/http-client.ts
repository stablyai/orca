import type { Session } from 'electron'
import type { Dispatcher } from 'undici'
import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment
} from '../../shared/network-proxy'

/**
 * Outbound HTTP for main-process integrations.
 *
 * Why a port: the desktop uses Electron's Chromium-backed network stack — it follows
 * session/proxy state, avoids undici's stale keep-alive sockets after a VPN path change,
 * and sends a Chrome user agent that some APIs (Jira's XSRF check) depend on. None of
 * that exists on a host with no Chromium.
 *
 * The Node default is the platform global. That is a real behavioural difference, not a
 * transparent swap, which is why this is a named port rather than a silent fallback:
 * a Node host reads proxy configuration from the environment instead of from Chromium,
 * and sends Node's user agent.
 *
 * Body safety (orca#8695): the global uses undici, where an unread response body can
 * crash the process. This port hands the Response straight to its caller and never
 * inspects it, so the consume/cancel obligation stays exactly where it already was —
 * with the caller, unchanged from when they called Electron's net directly.
 */

export type MainHttpClient = {
  fetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response>
  /** Additive OS trust without weakening certificate or hostname verification. */
  fetchWithSystemTrust(
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit
  ): Promise<Response>
  /** The Chromium session whose proxy state applies, or null on a host without one. */
  proxySession(): Session | null
}

type NodeSystemTrustTransport = {
  dispatcher: Dispatcher
  fetch: typeof globalThis.fetch
}

// Why: dispatchers are private Undici ABI; pair them with the fetch from the same package.
let nodeSystemTrustTransport: Promise<NodeSystemTrustTransport> | undefined

async function getNodeSystemTrustTransport(): Promise<NodeSystemTrustTransport> {
  nodeSystemTrustTransport ??= Promise.all([
    import('undici'),
    import('./first-party-tls-trust')
  ]).then(async ([{ Agent, EnvHttpProxyAgent, fetch }, { getFirstPartyCaCertificates }]) => {
    const ca = await getFirstPartyCaCertificates()
    const proxy = getProxyUrlFromEnvironment(process.env)
    const packageFetch = fetch as unknown as typeof globalThis.fetch
    if (!proxy.ok || !/^https?:/.test(proxy.value)) {
      return {
        dispatcher: new Agent({ connect: { ca, rejectUnauthorized: true } }),
        fetch: packageFetch
      }
    }
    const proxyOptions = {
      connect: { ca, rejectUnauthorized: true },
      proxyTls: { ca, rejectUnauthorized: true },
      requestTls: { ca, rejectUnauthorized: true },
      httpProxy: proxy.value,
      httpsProxy: proxy.value,
      noProxy: getProxyBypassRulesFromEnvironment(process.env).replaceAll(';', ',')
    }
    return {
      dispatcher: new EnvHttpProxyAgent(proxyOptions),
      fetch: packageFetch
    }
  })
  return nodeSystemTrustTransport
}

const nodeHttpClient: MainHttpClient = {
  fetch: (url, init) => globalThis.fetch(url, init),
  fetchWithSystemTrust: async (url, init) => {
    const transport = await getNodeSystemTrustTransport()
    return transport.fetch(url, { ...init, dispatcher: transport.dispatcher } as RequestInit)
  },
  proxySession: () => null
}

let current: MainHttpClient = nodeHttpClient

export function setMainHttpClient(client: MainHttpClient | null): void {
  current = client ?? nodeHttpClient
}

export function getMainHttpClient(): MainHttpClient {
  return current
}
