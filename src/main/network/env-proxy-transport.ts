import type { Agent as HttpAgent } from 'node:http'
import tls from 'node:tls'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { SocksClient, type SocksProxy } from 'socks'
import { SocksProxyAgent } from 'socks-proxy-agent'
import { resolveEnvProxy, type EnvProxy } from './env-proxy'

// Why: Electron's main process ignores proxy env vars for fetch (and `ws` always does).
// Only the Orca account/relay calls opt in here. The embedded browser (Chromium session)
// and local sockets never go through this module.

const dispatchers = new Map<string, Dispatcher>()

function socksProxyOf(proxy: EnvProxy): SocksProxy {
  const url = new URL(proxy.url)
  return {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port) || 1080,
    type: proxy.scheme === 'socks4' ? 4 : 5,
    userId: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined
  }
}

function createSocksDispatcher(proxy: EnvProxy): Dispatcher {
  const socksProxy = socksProxyOf(proxy)
  return new Agent({
    connect: (options, callback) => {
      const port = Number(options.port) || (options.protocol === 'https:' ? 443 : 80)
      // Why: socks5h/socks4a hand the hostname to the proxy; plain socks5 would resolve locally,
      // which defeats a tunnel that exists because direct traffic is blocked. Always send the name.
      SocksClient.createConnection({
        proxy: socksProxy,
        command: 'connect',
        destination: { host: options.hostname, port }
      }).then(
        ({ socket }) => {
          if (options.protocol !== 'https:') {
            callback(null, socket)
            return
          }
          const secure = tls.connect({
            socket,
            servername: options.servername ?? options.hostname
          })
          secure.once('secureConnect', () => callback(null, secure))
          secure.once('error', (error) => callback(error, null))
        },
        (error: Error) => callback(error, null)
      )
    }
  })
}

function dispatcherFor(proxy: EnvProxy): Dispatcher {
  let dispatcher = dispatchers.get(proxy.url)
  if (!dispatcher) {
    dispatcher =
      proxy.scheme === 'http' || proxy.scheme === 'https'
        ? new ProxyAgent(proxy.url)
        : createSocksDispatcher(proxy)
    dispatchers.set(proxy.url, dispatcher)
  }
  return dispatcher
}

/**
 * A fetch that tunnels through the env-configured proxy for each URL, or null when the
 * environment names no proxy at all (callers then keep using the global fetch unchanged).
 */
export function createEnvProxyFetch(env: NodeJS.ProcessEnv = process.env): typeof fetch | null {
  if (!hasProxyEnv(env)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: undici's fetch takes the same request shapes as the global fetch; only the nominal types differ.
  return ((input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input : input.url
    const proxy = resolveEnvProxy(url, env)
    if (!proxy) {
      return globalThis.fetch(input, init)
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: undici's fetch takes the same request shapes as the global fetch; only the nominal types differ.
    return undiciFetch(input as never, { ...(init as object), dispatcher: dispatcherFor(proxy) })
  }) as typeof fetch
}

/** fetch for account and relay HTTP calls: env-proxy aware when the env names a proxy. */
export function accountRelayFetch(): typeof fetch {
  return createEnvProxyFetch() ?? globalThis.fetch
}

/** `ws` agent for one relay socket URL, or undefined for a direct connection. */
export function envProxyWsAgent(
  url: string,
  env: NodeJS.ProcessEnv = process.env
): HttpAgent | undefined {
  const proxy = resolveEnvProxy(url, env)
  if (!proxy) {
    return undefined
  }
  if (proxy.scheme === 'http' || proxy.scheme === 'https') {
    return new HttpsProxyAgent(proxy.url)
  }
  // Names go to the proxy to resolve, same as the fetch path above.
  return new SocksProxyAgent(proxy.scheme === 'socks5' ? `socks5h${proxy.url.slice(6)}` : proxy.url)
}

/** Spread into a relay `new WebSocket(url, {...})`: adds nothing when no proxy applies. */
export function envProxyWsOptions(
  url: string,
  env: NodeJS.ProcessEnv = process.env
): { agent?: HttpAgent } {
  const agent = envProxyWsAgent(url, env)
  return agent ? { agent } : {}
}

function hasProxyEnv(env: NodeJS.ProcessEnv): boolean {
  return ['http_proxy', 'https_proxy', 'all_proxy'].some((name) =>
    (env[name] ?? env[name.toUpperCase()])?.trim()
  )
}
