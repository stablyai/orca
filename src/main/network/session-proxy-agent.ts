import { request as httpRequest } from 'node:http'
import { Agent, request as httpsRequest, type RequestOptions } from 'node:https'
import { isIP } from 'node:net'
import type { Duplex } from 'node:stream'
import type { ProxySession } from './electron-default-proxy-session'
import { electronProxyCredentialsFor } from './electron-proxy-credentials'
import { awaitProxySessionApplication } from './proxy-settings'

export type ResolvedProxyRoute =
  | { kind: 'direct' }
  | { kind: 'proxy'; secure: boolean; host: string; port: number }

const DIRECT_ROUTE: ResolvedProxyRoute = { kind: 'direct' }
const PROXY_TUNNEL_DEADLINE_MS = 15_000

/** Parse Chromium's resolveProxy answer, e.g. "PROXY a:8080; HTTPS b:443; DIRECT". */
export function parseResolvedProxyRoutes(resolved: string): ResolvedProxyRoute[] {
  const routes: ResolvedProxyRoute[] = []
  for (const entry of resolved.split(';')) {
    const [scheme = '', address] = entry.trim().split(/\s+/)
    const kind = scheme.toUpperCase()
    if (kind === 'DIRECT') {
      routes.push(DIRECT_ROUTE)
      continue
    }
    // SOCKS and QUIC entries are skipped; Chromium's list order supplies the fallback.
    if ((kind !== 'PROXY' && kind !== 'HTTP' && kind !== 'HTTPS') || !address) {
      continue
    }
    const secure = kind === 'HTTPS'
    try {
      const url = new URL(`${secure ? 'https' : 'http'}://${address}`)
      routes.push({
        kind: 'proxy',
        secure,
        host: url.hostname.replace(/^\[|\]$/g, ''),
        port: url.port ? Number(url.port) : secure ? 443 : 80
      })
    } catch {
      continue
    }
  }
  return routes
}

// A proxy that answered and refused is a policy decision, not an unreachable route.
class ProxyTunnelRejectedError extends Error {
  constructor(statusCode: number | undefined) {
    super(`proxy_tunnel_rejected_${statusCode}`)
    this.name = 'ProxyTunnelRejectedError'
  }
}

function hostForAuthority(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host
}

function openProxyTunnel(
  proxySession: ProxySession,
  route: Extract<ResolvedProxyRoute, { kind: 'proxy' }>,
  authority: string
): Promise<Duplex> {
  const credentials = electronProxyCredentialsFor(proxySession, route.host, route.port)
  const authorization = credentials
    ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
    : null
  return new Promise((resolve, reject) => {
    const request = (route.secure ? httpsRequest : httpRequest)({
      host: route.host,
      port: route.port,
      method: 'CONNECT',
      path: authority,
      headers: {
        host: authority,
        ...(authorization ? { 'proxy-authorization': authorization } : {})
      },
      agent: false,
      // '' stops Node falling back to the Host header (the relay) for the proxy's own TLS name.
      ...(route.secure ? { servername: isIP(route.host) ? '' : route.host } : {})
    })
    const deadline = setTimeout(
      () => request.destroy(new Error('proxy_tunnel_timeout')),
      PROXY_TUNNEL_DEADLINE_MS
    )
    deadline.unref()
    request.once('connect', (response, socket, head) => {
      clearTimeout(deadline)
      if (response.statusCode !== 200) {
        socket.destroy()
        reject(new ProxyTunnelRejectedError(response.statusCode))
        return
      }
      if (head.length > 0) {
        socket.unshift(head)
      }
      resolve(socket)
    })
    request.once('error', (error) => {
      clearTimeout(deadline)
      reject(error)
    })
    request.end()
  })
}

/**
 * An https Agent that routes each connection the way the Chromium session would: through
 * the HTTP/HTTPS CONNECT proxy its PAC/system/fixed rules pick, else directly. Lets Node
 * sockets (ws) follow the same proxy as net.fetch.
 */
export class SessionProxyAgent extends Agent {
  constructor(private readonly proxySession: ProxySession) {
    super()
  }

  override createConnection(
    options: RequestOptions,
    callback?: (error: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    this.connectThroughSession(options).then(
      (stream) => callback?.(null, stream),
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error))
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Node's oncreate returns on an error before reading the stream; the typings demand one anyway.
        callback?.(failure, undefined as unknown as Duplex)
      }
    )
    return undefined
  }

  private async connectThroughSession(options: RequestOptions): Promise<Duplex> {
    // Fail closed while a proxy change is applying, matching the session's request guard.
    if (!(await awaitProxySessionApplication(this.proxySession))) {
      throw new Error('proxy_settings_not_ready')
    }
    const host = String(options.host ?? options.hostname ?? 'localhost')
    const port = Number(options.port ?? 443)
    const authority = `${hostForAuthority(host)}:${port}`
    // Chromium resolves wss:// proxies as https://.
    const routes = parseResolvedProxyRoutes(
      await this.proxySession.resolveProxy(`https://${authority}/`)
    )
    // A SOCKS-only answer stays direct, as before; Chromium itself still uses SOCKS for net.fetch.
    let lastError: unknown = null
    for (const route of routes.length > 0 ? routes : [DIRECT_ROUTE]) {
      if (route.kind === 'direct') {
        return this.startTls(options)
      }
      try {
        return this.startTls(options, await openProxyTunnel(this.proxySession, route, authority))
      } catch (error) {
        // Like Chromium, fall back only when the proxy is unreachable, never past a refusal.
        if (error instanceof ProxyTunnelRejectedError) {
          throw error
        }
        lastError = error
      }
    }
    throw lastError
  }

  private startTls(options: RequestOptions, socket?: Duplex): Duplex {
    const tlsOptions: RequestOptions & { socket?: Duplex } = socket
      ? { ...options, socket }
      : options
    const stream = super.createConnection(tlsOptions)
    if (!stream) {
      throw new Error('proxy_tls_start_failed')
    }
    return stream
  }
}
