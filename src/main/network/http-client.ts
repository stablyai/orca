import type { Session } from 'electron'
import type { Dispatcher } from 'undici'
import { outboundProxyFetchDispatcher } from './outbound-proxy'
import { ensureElectronProxyFromEnvironment } from './proxy-settings'

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
  fetch(input: RequestInfo, init?: RequestInit): Promise<Response>
  /** The Chromium session whose proxy state applies, or null on a host without one. */
  proxySession(): Session | null
}

/** The proxy policy is picked per target URL; a Request carries its own. */
function proxyTargetUrl(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
}

// The proxy the app is configured to use still applies here: without Chromium there is
// no session to carry it, so the resolved proxy becomes undici's per-request dispatcher.
const nodeHttpClient: MainHttpClient = {
  fetch: async (input, init) => {
    const dispatcher = await outboundProxyFetchDispatcher(proxyTargetUrl(input))
    // undici reads the dispatcher per request, which is how the resolved proxy reaches a
    // host with no Chromium session. The Response still goes straight back to the caller.
    const proxiedInit: RequestInit & { dispatcher?: Dispatcher } = dispatcher
      ? { ...init, dispatcher }
      : { ...init }
    return globalThis.fetch(input, proxiedInit)
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

/**
 * Fetch for main-process integrations that must honor the app-wide proxy: apply the
 * configured policy to the Chromium session first (a no-op on a host without one),
 * then send through the installed client — Electron's net.fetch on the desktop.
 *
 * Typed as the global fetch so it can stand in wherever a fetch is injected. The input
 * is forwarded with a Request intact (it keeps its own method, headers and body); only
 * the target URL, taken from it, selects the proxy. A bare URL is handed on as a string,
 * which loses nothing.
 *
 * A failed apply is not fatal to the request: it is attempted either way, and its own
 * transport error is what the caller reports.
 */
export const fetchWithConfiguredProxy: typeof globalThis.fetch = async (input, init) => {
  const httpClient = getMainHttpClient()
  const proxySession = httpClient.proxySession()
  await ensureElectronProxyFromEnvironment({
    ...(proxySession ? { proxySession } : {}),
    probeUrl: proxyTargetUrl(input)
  }).catch(() => {})
  return await httpClient.fetch(input instanceof URL ? input.toString() : input, init)
}
