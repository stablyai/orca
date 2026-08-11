// Why: `orca serve` clients are often plain browsers (web client, phones) that
// cannot SSH-tunnel to workspace dev servers. This single listener exposes every
// workspace-attributed HTTP port through one firewall hole, routed by Host
// header (`<worktree-label>--<port>.<preview-domain>`), so an external reverse
// proxy needs exactly one wildcard route.
import { createHash, timingSafeEqual } from 'node:crypto'
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'
import { forwardHttpRequestToTarget, forwardUpgradeToTarget } from '../http-proxy-forwarding'
import type {
  PreviewRouteEntry,
  PreviewRouteResolver,
  PreviewRouteTarget
} from './preview-route-resolver'
import {
  buildPreviewPortUrl,
  parsePreviewHost,
  PREVIEW_TOKEN_QUERY_PARAM,
  type PreviewPublicOrigin
} from './worktree-preview-routes'

export const PREVIEW_TOKEN_COOKIE = 'orca_preview_token'

export type PreviewProxyAuthMode = 'open' | 'token'

export type WorktreePreviewProxyOptions = {
  bindHost: string
  port: number
  origin: PreviewPublicOrigin
  auth: PreviewProxyAuthMode
  token: string | null
  resolveRoutes: PreviewRouteResolver
}

export class WorktreePreviewProxy {
  private server: Server | null = null
  private readonly upgradeSockets = new Set<Duplex>()

  constructor(private readonly options: WorktreePreviewProxyOptions) {
    if (options.auth === 'token' && !options.token) {
      throw new Error('Preview proxy token auth requires a token.')
    }
  }

  async start(): Promise<{ port: number }> {
    if (this.server) {
      throw new Error('Preview proxy is already running.')
    }
    const server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch(() => {
        respondText(response, 502, 'Preview proxy failed to route this request.')
      })
    })
    server.on('upgrade', (request, socket, head) => {
      this.upgradeSockets.add(socket)
      socket.once('close', () => this.upgradeSockets.delete(socket))
      void this.handleUpgrade(request, socket, head).catch(() => socket.destroy())
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port, this.options.bindHost, () => {
        server.off('error', reject)
        resolve()
      })
    })
    this.server = server
    const address = server.address()
    return { port: address && typeof address === 'object' ? address.port : this.options.port }
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) {
      return
    }
    for (const socket of this.upgradeSockets) {
      socket.destroy()
    }
    this.upgradeSockets.clear()
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Why: keep-alive sockets would hold close() open past process teardown.
      server.closeAllConnections?.()
    })
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = parsePreviewHost(request.headers.host, this.options.origin)
    if (!parsed) {
      respondText(
        response,
        404,
        `Unknown preview host. Expected <workspace>[--<port>].${this.options.origin.host}`
      )
      return
    }
    if (!this.authorizeRequest(request, response)) {
      return
    }
    const entry = await this.resolveEntry(parsed.label)
    if (!entry) {
      respondText(response, 404, `No workspace matches preview label "${parsed.label}".`)
      return
    }
    const target = await this.resolveTarget(entry, parsed.port)
    if (!target) {
      if (parsed.port !== null) {
        respondText(
          response,
          404,
          `Port ${parsed.port} is not listening in workspace "${entry.displayName}".`
        )
        return
      }
      this.respondPortIndex(response, entry)
      return
    }
    forwardHttpRequestToTarget({
      target: targetUrl(target.connectHost, target.port),
      request,
      response,
      routeLabel: `${entry.label}:${target.port}`,
      stripCookies: [PREVIEW_TOKEN_COOKIE]
    })
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): Promise<void> {
    const parsed = parsePreviewHost(request.headers.host, this.options.origin)
    if (!parsed) {
      socket.destroy()
      return
    }
    if (!this.authorizeUpgrade(request, socket)) {
      return
    }
    const entry = await this.resolveEntry(parsed.label)
    const target = entry ? await this.resolveTarget(entry, parsed.port) : null
    if (!target) {
      socket.destroy()
      return
    }
    forwardUpgradeToTarget({
      target: targetUrl(target.connectHost, target.port),
      request,
      socket,
      head,
      stripCookies: [PREVIEW_TOKEN_COOKIE]
    })
  }

  private async resolveEntry(label: string): Promise<PreviewRouteEntry | null> {
    const index = await this.options.resolveRoutes()
    const entry = index.get(label)
    if (entry) {
      return entry
    }
    // Why: worktrees created after the cached scan should route on first hit.
    const freshIndex = await this.options.resolveRoutes({ fresh: true })
    return freshIndex.get(label) ?? null
  }

  /** Why: returns the target rather than a port number because the retry may
   *  resolve against a fresher entry than the caller holds — `entry` belongs to
   *  the resolver's cached index and must not be written through. */
  private async resolveTarget(
    entry: PreviewRouteEntry,
    explicitPort: number | null
  ): Promise<PreviewRouteTarget | null> {
    const requested = explicitPort ?? entry.primaryPort
    const cached =
      requested === null ? undefined : entry.ports.find((candidate) => candidate.port === requested)
    if (cached) {
      return cached
    }
    // Why: dev servers start between scan ticks; retry once against a fresh scan
    // before reporting the port missing.
    const freshIndex = await this.options.resolveRoutes({ fresh: true })
    const freshEntry = freshIndex.get(entry.label)
    if (!freshEntry) {
      return null
    }
    const freshRequested = explicitPort ?? freshEntry.primaryPort
    if (freshRequested === null) {
      return null
    }
    return freshEntry.ports.find((candidate) => candidate.port === freshRequested) ?? null
  }

  /** Handles the response itself when the request is not allowed through. */
  private authorizeRequest(request: IncomingMessage, response: ServerResponse): boolean {
    if (this.options.auth === 'open' || !this.options.token) {
      return true
    }
    const url = new URL(request.url || '/', 'http://preview.invalid')
    const queryToken = url.searchParams.get(PREVIEW_TOKEN_QUERY_PARAM)
    if (queryToken !== null) {
      if (!tokensMatch(queryToken, this.options.token)) {
        respondText(response, 403, 'Invalid preview token.')
        return false
      }
      // Why: move the token from the shareable URL into a cookie scoped to the
      // whole preview domain, so one visit authorizes every workspace label and
      // the token stops appearing in the app's own request logs.
      url.searchParams.delete(PREVIEW_TOKEN_QUERY_PARAM)
      // Why: WHATWG parsing folds `\` into `/`, so a crafted path can surface
      // as a protocol-relative `//host` Location (open redirect); pin to root.
      const pathname = url.pathname.startsWith('//') ? '/' : url.pathname
      response.writeHead(302, {
        'set-cookie': this.buildAuthCookie(),
        location: `${pathname}${url.search}`,
        'cache-control': 'no-store'
      })
      response.end()
      return false
    }
    if (tokensMatch(readCookie(request, PREVIEW_TOKEN_COOKIE) ?? '', this.options.token)) {
      return true
    }
    respondText(
      response,
      401,
      `Missing preview token. Open the preview URL from Orca's ports panel (it carries ?${PREVIEW_TOKEN_QUERY_PARAM}=…).`
    )
    return false
  }

  private authorizeUpgrade(request: IncomingMessage, socket: Duplex): boolean {
    if (this.options.auth === 'open' || !this.options.token) {
      return true
    }
    // Why: browsers attach cookies to same-origin WebSocket upgrades, so the
    // page's auth cookie covers its HMR/WS connections; no token-in-URL path.
    if (tokensMatch(readCookie(request, PREVIEW_TOKEN_COOKIE) ?? '', this.options.token)) {
      return true
    }
    socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n')
    return false
  }

  private buildAuthCookie(): string {
    const attributes = [
      `${PREVIEW_TOKEN_COOKIE}=${this.options.token}`,
      // Why: Domain-scoped to the preview base host so every worktree label
      // subdomain shares the one authorization.
      `Domain=${this.options.origin.host}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax'
    ]
    if (this.options.origin.protocol === 'https') {
      attributes.push('Secure')
    }
    return attributes.join('; ')
  }

  private respondPortIndex(response: ServerResponse, entry: PreviewRouteEntry): void {
    if (entry.ports.length === 0) {
      respondText(
        response,
        404,
        `No HTTP ports detected in workspace "${entry.displayName}". Start a dev server there and retry.`
      )
      return
    }
    // Why: with several ports and no advertised one there is no safe default;
    // list them instead of guessing. Links omit the token: the visitor already
    // holds the domain-wide auth cookie.
    const links = entry.ports
      .map((target) => {
        const url = buildPreviewPortUrl({
          origin: this.options.origin,
          label: entry.label,
          port: target.port,
          token: null
        })
        return `<li><a href="${escapeHtml(url)}">:${target.port}</a></li>`
      })
      .join('')
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(
      `<!doctype html><meta charset="utf-8"><title>${escapeHtml(entry.displayName)} ports</title>` +
        `<p>Workspace <strong>${escapeHtml(entry.displayName)}</strong> is listening on several ports:</p>` +
        `<ul>${links}</ul>`
    )
  }
}

function targetUrl(connectHost: string, port: number): URL {
  const host = connectHost.includes(':') ? `[${connectHost}]` : connectHost
  return new URL(`http://${host}:${port}`)
}

function respondText(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent || response.writableEnded) {
    response.destroy()
    return
  }
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}

function tokensMatch(candidate: string, expected: string): boolean {
  // Why: sha256 both sides so timingSafeEqual gets equal-length buffers without
  // leaking the expected token's length.
  const candidateDigest = createHash('sha256').update(candidate).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return candidate.length > 0 && timingSafeEqual(candidateDigest, expectedDigest)
}

function readCookie(request: IncomingMessage, name: string): string | null {
  const header = request.headers.cookie
  if (!header) {
    return null
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1) {
      continue
    }
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim()
    }
  }
  return null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
