import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import https from 'node:https'
import net from 'node:net'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'
import type {
  LocalhostWorktreeLabelResult,
  LocalhostWorktreeLabelRoute
} from '../shared/localhost-worktree-labels'
import {
  connectableLoopbackHost,
  getLocalhostWorktreeHostLabel,
  getLocalhostWorktreeRouteKey
} from '../shared/localhost-worktree-labels'

type RegisteredRoute = LocalhostWorktreeLabelRoute & {
  label: string
  routeKey: string
  target: URL
}

const ORCA_LOCALHOST_SUFFIX = '.orca.localhost'

export class LocalhostWorktreeLabelProxy {
  private server: Server | null = null
  private listenPort: number | null = null
  private serverReady: Promise<void> | null = null
  private readonly routes = new Map<string, RegisteredRoute>()
  private readonly routeKeys = new Map<string, string>()

  async registerRoute(route: LocalhostWorktreeLabelRoute): Promise<LocalhostWorktreeLabelResult> {
    const target = parseTargetUrl(route.targetUrl)
    await this.ensureServer()
    const baseLabel = getLocalhostWorktreeHostLabel(route)
    const routeKey = getLocalhostWorktreeRouteKey(route)
    const previousLabel = this.routeKeys.get(routeKey)
    const label = previousLabel ?? this.nextAvailableLabel(baseLabel)
    const registered: RegisteredRoute = {
      ...route,
      label,
      routeKey,
      target
    }
    this.routes.set(label, registered)
    this.routeKeys.set(routeKey, label)
    return {
      label,
      url: this.buildLabeledUrl(label, target)
    }
  }

  // Why: routes are added per (worktreeId, targetUrl) but were never removed, so
  // labels for deleted worktrees accumulated in both maps for the whole session.
  // Drop them when the worktree is torn down. The shared http.Server stays up.
  unregisterWorktree(worktreeId: string): void {
    for (const [label, route] of this.routes) {
      if (route.worktreeId === worktreeId) {
        this.routes.delete(label)
        this.routeKeys.delete(route.routeKey)
      }
    }
  }

  private async ensureServer(): Promise<void> {
    if (this.server && this.listenPort !== null) {
      return
    }
    if (this.serverReady) {
      await this.serverReady
      return
    }

    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response)
    })
    server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head)
    })
    this.serverReady = new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        const address = server.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to start localhost label proxy.'))
          return
        }
        this.listenPort = address.port
        this.server = server
        resolve()
      })
    })
    try {
      await this.serverReady
    } catch (error) {
      this.serverReady = null
      throw error
    }
  }

  private nextAvailableLabel(baseLabel: string): string {
    if (!this.routes.has(baseLabel)) {
      return baseLabel
    }
    for (let index = 2; index < 1000; index += 1) {
      const candidate = `${baseLabel}-${index}`
      if (!this.routes.has(candidate)) {
        return candidate
      }
    }
    throw new Error('No available localhost label.')
  }

  private buildLabeledUrl(label: string, target: URL): string {
    if (this.listenPort === null) {
      throw new Error('Localhost label proxy is not running.')
    }
    const url = new URL(target.toString())
    url.hostname = `${label}${ORCA_LOCALHOST_SUFFIX}`
    url.port = String(this.listenPort)
    return url.toString()
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const route = this.routeForRequest(request)
    if (!route) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Unknown Orca localhost label.')
      return
    }

    const target = targetUrlForRequest(route.target, request)
    const proxyRequest = requestForTarget(target, {
      method: request.method,
      headers: requestHeadersForTarget(request, route.target)
    })

    // Why: a client abort or downstream socket error must tear down the
    // upstream request instead of surfacing as an uncaught exception/leak.
    request.on('error', () => proxyRequest.destroy())
    response.on('error', () => proxyRequest.destroy())

    // Why: the proxy only relabels the hostname; responses are streamed
    // through untouched so app headers (CSP, cookies) and bodies are
    // preserved exactly as the dev server sent them.
    proxyRequest.on('response', (proxyResponse) => {
      proxyResponse.on('error', () => response.destroy())
      response.writeHead(proxyResponse.statusCode ?? 502, proxyResponse.headers)
      proxyResponse.pipe(response)
    })
    proxyRequest.on('error', (error) => {
      // Why: once headers/bytes are flushed we can't write a 502, so tear the
      // socket down to avoid an ERR_HTTP_HEADERS_SENT crash.
      if (response.headersSent) {
        response.destroy(error)
        return
      }
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      response.end(`Proxy failed for ${route.label}: ${error.message}`)
    })
    request.pipe(proxyRequest)
  }

  private handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const route = this.routeForRequest(request)
    if (!route) {
      socket.destroy()
      return
    }

    const target = targetUrlForRequest(route.target, request)
    const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
    const targetSocket = net.connect(targetPort, connectableLoopbackHost(target.hostname), () => {
      const headers = requestHeadersForTarget(request, route.target)
      targetSocket.write(
        `${request.method ?? 'GET'} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n`
      )
      for (const [name, value] of Object.entries(headers)) {
        if (Array.isArray(value)) {
          for (const entry of value) {
            targetSocket.write(`${name}: ${entry}\r\n`)
          }
        } else if (value !== undefined) {
          targetSocket.write(`${name}: ${value}\r\n`)
        }
      }
      targetSocket.write('\r\n')
      if (head.length > 0) {
        targetSocket.write(head)
      }
      targetSocket.pipe(socket)
      socket.pipe(targetSocket)
    })
    targetSocket.on('error', () => socket.destroy())
    socket.on('error', () => targetSocket.destroy())
  }

  private routeForRequest(request: IncomingMessage): RegisteredRoute | null {
    const host =
      String(request.headers.host ?? '')
        .split(':')[0]
        ?.toLowerCase() ?? ''
    if (!host.endsWith(ORCA_LOCALHOST_SUFFIX)) {
      return null
    }
    const label = host.slice(0, -ORCA_LOCALHOST_SUFFIX.length)
    return this.routes.get(label) ?? null
  }
}

export const localhostWorktreeLabelProxy = new LocalhostWorktreeLabelProxy()

function parseTargetUrl(rawUrl: string): URL {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:') {
    throw new Error('Only http workspace ports can be labeled.')
  }
  return url
}

function requestForTarget(
  target: URL,
  options: { method?: string; headers: http.OutgoingHttpHeaders }
): http.ClientRequest {
  const requestOptions = {
    protocol: target.protocol,
    hostname: connectableLoopbackHost(target.hostname),
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: options.method,
    headers: options.headers
  }
  return target.protocol === 'https:' ? https.request(requestOptions) : http.request(requestOptions)
}

function targetUrlForRequest(target: URL, request: IncomingMessage): URL {
  const url = new URL(target.toString())
  const incomingUrl = new URL(request.url || '/', target)
  url.pathname = incomingUrl.pathname
  url.search = incomingUrl.search
  return url
}

function requestHeadersForTarget(request: IncomingMessage, target: URL): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...request.headers }
  headers.host = target.host
  return headers
}
