import type { Agent } from 'node:http'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { ProxyAgent, type Dispatcher } from 'undici'
import {
  getProxyBypassRulesFromEnvironment,
  getProxyUrlFromEnvironment
} from '../../shared/network-proxy'
import { defaultProxySession, type ProxySession } from './electron-default-proxy-session'
import { getElectronProxyCredentialsForSession } from './electron-proxy-credentials'

/**
 * The proxy that main-process Node-side connections — WebSocket sockets and the
 * Chromium-less fetch fallback — must tunnel through for a given target.
 *
 * Chromium owns the policy: app Settings, then proxy env vars, then the system
 * proxy, including the bypass list. `session.resolveProxy` is therefore the only
 * authority the desktop consults; a host with no Chromium session has no other source
 * (`main/startup/main-process-preflight.ts` installs both together), so there the proxy
 * env vars are read directly, credentials included, without a bypass matcher — every
 * non-loopback target goes through them.
 *
 * Only a plain HTTP proxy can be tunnelled here: HTTPS-proxy and SOCKS rules from
 * the resolver are deliberately left direct, matching what those transports did
 * before this existed rather than sending them somewhere they cannot reach.
 */

const DEFAULT_PROXY_PORTS: Record<string, string> = {
  'http:': '80',
  'https:': '443'
}

function normalizedHostname(url: URL | string): string {
  return (typeof url === 'string' ? url : url.hostname).replace(/^\[|\]$/g, '').toLowerCase()
}

function isLoopbackHost(url: URL): boolean {
  const host = normalizedHostname(url)
  // Chromium's implicit bypass covers the whole 127.0.0.0/8 range, not just .0.1.
  return host === 'localhost' || host === '::1' || host.startsWith('127.')
}

/** Chromium's proxy resolver is asked about the http(s) sibling of a ws(s) target. */
function proxyProbeUrl(targetUrl: string): string {
  const url = new URL(targetUrl)
  if (url.protocol === 'wss:') {
    url.protocol = 'https:'
  } else if (url.protocol === 'ws:') {
    url.protocol = 'http:'
  }
  return url.toString()
}

/**
 * Chromium returns an ordered failover list. Only the first directive can be honoured
 * faithfully: the later ones are fallbacks for a failed attempt this layer cannot observe,
 * so a route that starts with `DIRECT` — or with a directive it cannot tunnel — stays
 * direct instead of being promoted to a proxy the app only meant as a fallback.
 */
function proxyUrlFromRules(rules: string): string | null {
  const first = /^\s*(\S+)\s+(\S+)\s*$/.exec((rules.split(';')[0] ?? '').trim())
  if (!first || first[1]!.toUpperCase() !== 'PROXY') {
    return null
  }
  return `http://${first[2]}`
}

/**
 * Node's `NO_PROXY` convention: `*`, a host, or a domain suffix, each optionally with a
 * port. Entries this cannot express (`<local>`, `<-loopback>`, CIDR blocks) are ignored,
 * which keeps the proxy in play rather than bypassing it by accident.
 */
function isEnvBypassed(env: Record<string, string | undefined>, url: URL): boolean {
  const rules = getProxyBypassRulesFromEnvironment(env)
  if (!rules) {
    return false
  }
  const host = normalizedHostname(url)
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  for (const rule of rules.split(';')) {
    const entry = /^\[([^\]]+)\](?::(\d+))?$/.exec(rule) ?? /^([^:]+)(?::(\d+))?$/.exec(rule)
    if (!entry) {
      continue
    }
    if (entry[2] && entry[2] !== port) {
      continue
    }
    const ruleHost = entry[1]!.toLowerCase()
    // A leading dot names the same suffix as a bare host: `.corp.example` and
    // `corp.example` both cover the domain and everything under it.
    const suffix = ruleHost.startsWith('.') ? ruleHost.slice(1) : ruleHost
    if (ruleHost === '*' || host === suffix || host.endsWith(`.${suffix}`)) {
      return true
    }
  }
  return false
}

/**
 * Chromium answers with the proxy it would use but without credentials, which it
 * supplies on the auth challenge instead. A Node socket has no such hook, so the
 * credentials the same settings produced are attached when host and port match.
 * Returns null for a rule value that is not a usable proxy, which resolves as direct.
 */
function withProxyCredentials(
  proxyUrl: string,
  proxySession: ProxySession | null,
  credentials: ReturnType<typeof getElectronProxyCredentialsForSession>
): string | null {
  let url: URL
  try {
    url = new URL(proxyUrl)
  } catch {
    return null
  }
  if (!proxySession || !credentials) {
    return proxyUrl
  }
  const port = url.port || DEFAULT_PROXY_PORTS[url.protocol] || ''
  if (
    normalizedHostname(url) !== normalizedHostname(credentials.host) ||
    Number(port) !== credentials.port
  ) {
    return proxyUrl
  }
  url.username = encodeURIComponent(credentials.username)
  url.password = encodeURIComponent(credentials.password)
  return `${url.protocol}//${url.username}:${url.password}@${url.host}`
}

export async function resolveOutboundProxyUrl(targetUrl: string): Promise<string | null> {
  const probe = new URL(proxyProbeUrl(targetUrl))
  // Chromium implicitly bypasses loopback unless the list asks otherwise; local
  // relay cells and dev servers must keep working with a proxy configured.
  if (isLoopbackHost(probe)) {
    return null
  }
  const proxySession = defaultProxySession()
  if (proxySession) {
    const credentials = getElectronProxyCredentialsForSession(proxySession)
    const resolved = proxyUrlFromRules(await proxySession.resolveProxy(probe.toString()))
    return resolved === null ? null : withProxyCredentials(resolved, proxySession, credentials)
  }
  // Why the raw env value rather than the resolved policy: `resolveProxyPolicyWithoutSession`
  // hands back rules with the userinfo stripped, because Chromium answers an auth challenge
  // instead, and there is no session credential store to read on this path — the credentials
  // have to travel in the URL or an authenticated proxy rejects the request. A proxy URL the
  // user wrote with credentials is also sent the way Chromium would send it: as
  // `Proxy-Authorization` to that proxy, which is plaintext when the proxy itself is http.
  const envProxy = getProxyUrlFromEnvironment(process.env)
  if (!envProxy.ok || !envProxy.value || isEnvBypassed(process.env, probe)) {
    return null
  }
  return envProxy.value
}

const socketAgentsByProxyUrl = new Map<string, Agent>()
const dispatchersByProxyUrl = new Map<string, Dispatcher>()

/** A socket agent for the relay's WebSocket connections, or undefined to go direct. */
export async function outboundProxySocketAgent(targetUrl: string): Promise<Agent | undefined> {
  const proxyUrl = await resolveOutboundProxyUrl(targetUrl)
  if (!proxyUrl) {
    return undefined
  }
  let agent = socketAgentsByProxyUrl.get(proxyUrl)
  if (!agent) {
    // CONNECT-tunnels ws:// and wss:// alike, so one agent serves both.
    agent = new HttpsProxyAgent(proxyUrl)
    socketAgentsByProxyUrl.set(proxyUrl, agent)
  }
  return agent
}

/** The dispatcher for the Node fetch fallback, or undefined to go direct. */
export async function outboundProxyFetchDispatcher(
  targetUrl: string
): Promise<Dispatcher | undefined> {
  const proxyUrl = await resolveOutboundProxyUrl(targetUrl)
  if (!proxyUrl) {
    return undefined
  }
  let dispatcher = dispatchersByProxyUrl.get(proxyUrl)
  if (!dispatcher) {
    dispatcher = new ProxyAgent({ uri: proxyUrl })
    dispatchersByProxyUrl.set(proxyUrl, dispatcher)
  }
  return dispatcher
}
