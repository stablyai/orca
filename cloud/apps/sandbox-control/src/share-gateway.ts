// Public share gateway: validates a share token, then forwards the visitor's request to the VM's
// share proxy (image/vm/orca-share-proxy) with a header signed by that session's key. The raw
// *.vercel.run route of the proxy answers 404 to anything without that header.
//
// URL shapes:
//   subdomain mode  https://<token><SHARE_HOST_SUFFIX>/<path>   production: every link is its own
//                   origin. SHARE_HOST_SUFFIX must be its own registrable domain, listed on the Public
//                   Suffix List and separate from the control plane's, so browsers treat each
//                   `<token>.` host as a separate site (app cookies are also forced host-only). A shared app can't read
//                   another link's cookies, register a service worker over it, or script control-plane
//                   pages (OAuth consent, MCP).
//   path mode       https://<control plane>/s/<token>/<path>   dev only (SHARE_PATH_MODE): every link
//                   shares the control plane's origin. To contain that, app cookies are renamed and
//                   scoped to the link's path, service workers are refused, Referer never reaches the VM
//                   and responses send none. Apps must use relative URLs or the `x-forwarded-prefix`
//                   base; root-relative paths are not served (they would be control-plane routes).
//
// Gateway-owned paths under a link root: `__orca/status` (GET), `__orca/wake` (POST, link opt-in),
// `__orca/enter?code=` (team-only sign-in from the desktop, see POST /v1/shares/:token/visit).
import type { SandboxProviderApi } from './sandbox-provider'
import { ORCAD_PORT, SHARE_PROXY_PORT } from './sandbox-vm-commands'
import { shareProxyKey, signProxyHeader, verifyTicket, type ShareSecrets } from './share-crypto'
import {
  ACCOUNT_TEAM_DIRECTORY,
  VIEWER_SESSION_MS,
  canView,
  claimShareWake,
  openViewer,
  redeemEnterCode,
  sealViewer,
  shareState,
  type ShareLinkRow,
  type TeamDirectory
} from './share-links'
import { sharePage } from './share-pages'
import { getSandbox, type SandboxRow } from './store'

export const VIEWER_COOKIE = '__orca_viewer'
/** Link + sandbox rows are re-read at least this often, so a revoke or suspend lands within it. */
export const LINK_CACHE_MS = 10_000
const ROUTE_CACHE_MS = 30_000
/** A visitor may trigger at most one wake per link per minute. */
const WAKE_WINDOW_MS = 60_000
/** Requests per link per minute, per gateway isolate. */
export const LINK_REQUESTS_PER_MINUTE = 1200
/** Request headers that never reach the VM (identity, Cloudflare and proxy bookkeeping, referrers). */
const DROP_REQUEST = /^(host|cookie|referer|cf-.*|x-forwarded-.*|x-real-ip|forwarded|x-orca-.*|cdn-loop|true-client-ip)$/
const DROP_RESPONSE = /^(x-orca-share.*|x-vercel-.*|server|strict-transport-security|set-cookie|referrer-policy)$/

export type ShareGatewayDeps = {
  db: D1Database
  /** Current secret first, then a retired one still accepted during rotation. */
  secrets: readonly string[]
  provider: SandboxProviderApi
  now: () => number
  /** Starts a wake of a sleeping sandbox (resolves when started, not when ready). */
  wake: (sandbox: SandboxRow) => Promise<void>
  hostSuffix?: string
  /** `/s/<token>/` on the control plane's own origin; dev only (see the header). */
  pathMode: boolean
  directory?: TeamDirectory
  fetch?: typeof fetch
}

type Resolved = { link: ShareLinkRow; sandbox: SandboxRow }
const linkCache = new Map<string, { at: number; value: Promise<Resolved | null> }>()
const routeCache = new Map<string, { at: number; url: Promise<string> }>()
const rates = new Map<string, { at: number; count: number }>()

export function forgetShareLink(id: string): void {
  linkCache.delete(id)
}

function prune<T extends { at: number }>(cache: Map<string, T>, now: number, ttl: number) {
  if (cache.size < 500) {
    return
  }
  for (const [key, entry] of cache) {
    if (now - entry.at >= ttl) {
      cache.delete(key)
    }
  }
}

/** Per-isolate fixed window; a flood against one link can't run up the owner's VM indefinitely. */
function overRate(linkId: string, now: number): boolean {
  prune(rates, now, 60_000)
  const entry = rates.get(linkId)
  if (!entry || now - entry.at >= 60_000) {
    rates.set(linkId, { at: now, count: 1 })
    return false
  }
  entry.count++
  return entry.count > LINK_REQUESTS_PER_MINUTE
}

async function loadResolved(db: D1Database, id: string): Promise<Resolved | null> {
  const link = await db.prepare('SELECT * FROM share_links WHERE id = ?').bind(id).first<ShareLinkRow>()
  const sandbox = link ? await getSandbox(db, link.sandbox_id) : null
  return link && sandbox ? { link, sandbox } : null
}

function resolve(db: D1Database, id: string, now: number, fresh = false): Promise<Resolved | null> {
  const hit = linkCache.get(id)
  if (!fresh && hit && now - hit.at < LINK_CACHE_MS) {
    return hit.value
  }
  prune(linkCache, now, LINK_CACHE_MS)
  const value = loadResolved(db, id)
  linkCache.set(id, { at: now, value })
  value.catch(() => linkCache.delete(id))
  return value
}

/** The proxy's public route for this session; adds port 6769 to sandboxes created before share links. */
function proxyRoute(deps: ShareGatewayDeps, sandbox: SandboxRow): Promise<string> {
  const key = `${sandbox.id}:${sandbox.session_id}`
  const now = deps.now()
  const hit = routeCache.get(key)
  if (hit && now - hit.at < ROUTE_CACHE_MS) {
    return hit.url
  }
  prune(routeCache, now, ROUTE_CACHE_MS)
  const url = (async () => {
    const state = await deps.provider.getSandbox(sandbox.provider_name, { resume: false })
    const existing = state?.routes.find((route) => route.port === SHARE_PROXY_PORT)
    if (existing) {
      return existing.url
    }
    const ports = [...new Set([ORCAD_PORT, ...(state?.routes.map((route) => route.port) ?? []), SHARE_PROXY_PORT])]
    const added = (await deps.provider.updatePorts(sandbox.provider_name, ports)).find((route) => route.port === SHARE_PROXY_PORT)
    if (!added) {
      throw new Error('share route missing')
    }
    return added.url
  })()
  routeCache.set(key, { at: now, url })
  url.catch(() => routeCache.delete(key))
  return url
}

function requestCookies(request: Request): [string, string][] {
  const cookies: [string, string][] = []
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0) {
      cookies.push([part.slice(0, at).trim(), part.slice(at + 1).trim()])
    }
  }
  return cookies
}

export function readCookie(request: Request, name: string): string | undefined {
  return requestCookies(request).find(([key]) => key === name)?.[1]
}

type Located = { token: string; base: string; rest: string; mode: 'path' | 'host' }

/** Which link (if any) a request is for; `rest` is the path to ask the app for. */
function locate(url: URL, deps: ShareGatewayDeps): Located | 'redirect' | null {
  if (deps.hostSuffix && url.hostname.endsWith(deps.hostSuffix)) {
    const token = url.hostname.slice(0, -deps.hostSuffix.length)
    return { token, base: '/', rest: url.pathname, mode: 'host' }
  }
  const match = deps.pathMode ? /^\/s\/([0-9a-f]{52})(\/.*)?$/.exec(url.pathname) : null
  if (!match) {
    return null
  }
  if (match[2] === undefined) {
    return 'redirect'
  }
  return { token: match[1]!, base: `/s/${match[1]}/`, rest: match[2], mode: 'path' }
}

/**
 * App cookies on a shared origin (path mode) are renamed `s<id8>.<name>` and scoped to the link's
 * path: only this link's own cookies go back to its app, nothing else on the origin.
 */
function appCookiePrefix(located: Located, linkId: string): string | null {
  return located.mode === 'path' ? `s${linkId.slice(0, 8)}.` : null
}

function cookiesForApp(request: Request, located: Located, linkId: string): string | null {
  const prefix = appCookiePrefix(located, linkId)
  const kept = requestCookies(request).flatMap(([name, value]) => {
    if (name.startsWith('__orca_')) {
      return []
    }
    if (prefix === null) {
      return [`${name}=${value}`]
    }
    return name.startsWith(prefix) ? [`${name.slice(prefix.length)}=${value}`] : []
  })
  return kept.length > 0 ? kept.join('; ') : null
}

function cookieForVisitor(setCookie: string, located: Located, linkId: string): string | null {
  const [pair = '', ...attributes] = setCookie.split(';')
  const at = pair.indexOf('=')
  const name = at > 0 ? pair.slice(0, at).trim() : ''
  if (!name || name.startsWith('__orca_')) {
    return null
  }
  const prefix = appCookiePrefix(located, linkId)
  // Host-only always: a Domain= cookie from one share's subdomain would land on every other share.
  const kept = attributes
    .map((attr) => attr.trim())
    .filter((attr) => attr && !/^domain\s*=/i.test(attr) && (prefix === null || !/^path\s*=/i.test(attr)))
  if (prefix === null) {
    return [pair.trim(), ...kept].join('; ')
  }
  return [`${prefix}${name}=${pair.slice(at + 1).trim()}`, ...kept, `Path=${located.base}`].join('; ')
}

function viewerCookie(value: string, located: Located, maxAgeSeconds: number): string {
  return `${VIEWER_COOKIE}=${value}; Path=${located.base}; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}; HttpOnly; Secure; SameSite=Lax`
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function viewState(sandbox: SandboxRow): 'ready' | 'sleeping' | 'waking' | 'archived' | 'unavailable' {
  if (sandbox.status === 'running' && sandbox.session_id) {
    return 'ready'
  }
  // Unarchive is an explicit owner action; a preview link never does it.
  if (sandbox.status === 'archived') {
    return 'archived'
  }
  if (sandbox.status === 'suspended') {
    return 'sleeping'
  }
  if (sandbox.status === 'resuming' || sandbox.status === 'creating') {
    return 'waking'
  }
  return 'unavailable'
}

/** Rewrites an app redirect that points at the app's own root back under the link. */
function rewriteLocation(location: string, located: Located, port: number): string {
  if (located.mode !== 'path') {
    return location
  }
  const local = new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${port}(?=/|$)`)
  const path = location.replace(local, '')
  return path.startsWith('/') && !path.startsWith('//') ? `${located.base.slice(0, -1)}${path}` : location
}

async function signedProxyHeaders(
  deps: ShareGatewayDeps,
  sandbox: SandboxRow,
  link: ShareLinkRow,
  secret: string = deps.secrets[0]!
): Promise<Headers> {
  const key = await shareProxyKey(secret, sandbox.id, sandbox.session_id!)
  // Wall clock, not deps.now: the VM checks the signature's window against its own clock.
  const header = await signProxyHeader(key, { port: link.port, linkId: link.id, linkExpiresAt: link.expires_at }, Date.now())
  return new Headers({ 'x-orca-share': header })
}

/** A HEAD through the proxy: false while nothing listens on the link's port. */
async function portAnswers(deps: ShareGatewayDeps, sandbox: SandboxRow, link: ShareLinkRow): Promise<boolean> {
  try {
    const route = await proxyRoute(deps, sandbox)
    const answer = await (deps.fetch ?? fetch)(`${route}/`, {
      method: 'HEAD',
      headers: await signedProxyHeaders(deps, sandbox, link),
      redirect: 'manual'
    })
    return answer.headers.get('x-orca-share-proxy') === '1' && !answer.headers.get('x-orca-share-error')
  } catch {
    return false
  }
}

/** The app's response headers the visitor may see (cookies scoped, proxy and referrer bits dropped). */
function visitorHeaders(upstream: Response, located: Located, link: ShareLinkRow): Headers {
  const headers = new Headers()
  for (const [name, value] of upstream.headers) {
    // A worker scope wider than its script's path would reach over other links on a shared origin.
    if (DROP_RESPONSE.test(name) || (located.mode === 'path' && name === 'service-worker-allowed')) {
      continue
    }
    headers.set(name, name === 'location' ? rewriteLocation(value, located, link.port) : value)
  }
  for (const value of upstream.headers.getSetCookie?.() ?? []) {
    const cookie = cookieForVisitor(value, located, link.id)
    if (cookie) {
      headers.append('set-cookie', cookie)
    }
  }
  headers.set('x-robots-tag', 'noindex, nofollow')
  // The token is in the URL: never send it on to other sites (or other links).
  headers.set('referrer-policy', 'no-referrer')
  return headers
}

/** Share traffic, or null when the request isn't for a share link (the caller continues routing). */
export async function handleShareGateway(request: Request, url: URL, deps: ShareGatewayDeps): Promise<Response | null> {
  const located = locate(url, deps)
  if (!located) {
    return null
  }
  if (located === 'redirect') {
    return new Response(null, { status: 308, headers: { location: `${url.pathname}/${url.search}`, 'cache-control': 'no-store' } })
  }
  const now = deps.now()
  const id = await verifyTicket(deps.secrets as ShareSecrets, located.token)
  if (!id) {
    return sharePage('not_found')
  }
  if (overRate(id, now)) {
    return new Response('Too many requests', { status: 429, headers: { 'retry-after': '60', 'cache-control': 'no-store' } })
  }
  const internal = located.rest.startsWith('/__orca/') ? located.rest.slice('/__orca/'.length) : null
  const resolved = await resolve(deps.db, id, now, internal !== null)
  if (!resolved) {
    return sharePage('not_found')
  }
  const { link, sandbox } = resolved
  const state = shareState(link, now)
  if (state !== 'active') {
    return sharePage(state)
  }
  if (sandbox.status === 'destroyed' || sandbox.status === 'destroying') {
    return sharePage('gone')
  }

  if (internal === 'enter' && request.method === 'GET') {
    const viewer = await redeemEnterCode(deps.db, deps.secrets, link.id, url.searchParams.get('code') ?? '', now)
    if (!viewer || !(await canView(viewer, sandbox, link, deps.directory ?? ACCOUNT_TEAM_DIRECTORY))) {
      return sharePage(viewer ? 'team_forbidden' : 'team_signin', { token: located.token })
    }
    const headers = new Headers({ location: located.base, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    headers.append('set-cookie', viewerCookie(await sealViewer(deps.secrets[0]!, viewer, now, link.id), located, VIEWER_SESSION_MS / 1000))
    return new Response(null, { status: 302, headers })
  }

  const viewer = await openViewer(deps.secrets, readCookie(request, VIEWER_COOKIE), now, link.id)
  if (!(await canView(viewer, sandbox, link, deps.directory ?? ACCOUNT_TEAM_DIRECTORY))) {
    return internal ? json({ error: 'forbidden' }, viewer ? 403 : 401) : sharePage(viewer ? 'team_forbidden' : 'team_signin', { token: located.token })
  }

  if (internal === 'status' && request.method === 'GET') {
    const state = viewState(sandbox)
    // `?probe=1` (the "nothing listening" page) also asks the VM whether the port answers now.
    const listening =
      state === 'ready' && url.searchParams.get('probe') === '1' ? await portAnswers(deps, sandbox, link) : undefined
    return json({ state, canWake: link.allow_wake === 1, ...(listening === undefined ? {} : { listening }) })
  }
  if (internal === 'wake' && request.method === 'POST') {
    if (request.headers.get('x-orca-wake') !== '1') {
      return json({ error: 'invalid_request' }, 400)
    }
    if (link.allow_wake !== 1) {
      return json({ error: 'forbidden', reason: 'not_allowed' }, 403)
    }
    if (sandbox.status === 'suspended') {
      const claim = await claimShareWake(deps.db, link, now, WAKE_WINDOW_MS)
      if (claim === 'daily_limit') {
        return json({ error: 'rate_limited', reason: 'wake_limit' }, 429)
      }
      if (claim === 'ok') {
        console.log(JSON.stringify({ event: 'share_wake', sandboxId: sandbox.id }))
        try {
          await deps.wake(sandbox)
        } catch {
          return json({ error: 'wake_failed' }, 502)
        }
        forgetShareLink(link.id)
        return json({ state: 'waking' })
      }
    }
    return json({ state: viewState(sandbox) === 'sleeping' ? 'waking' : viewState(sandbox) })
  }

  // A service worker on the shared origin could intercept every other link and control-plane page.
  if (located.mode === 'path' && request.headers.get('service-worker') === 'script') {
    return new Response('Service workers are not available on this link.', { status: 403, headers: { 'cache-control': 'no-store' } })
  }

  const page = (kind: Parameters<typeof sharePage>[0]) => sharePage(kind, { port: link.port, base: located.base })
  const status = viewState(sandbox)
  if (status === 'sleeping') {
    return page(link.allow_wake === 1 ? 'asleep' : 'asleep_no_wake')
  }
  if (status === 'waking') {
    return page('waking')
  }
  if (status === 'archived') {
    return page('asleep_no_wake')
  }
  if (status === 'unavailable') {
    return page('unreachable')
  }

  let upstream: Response
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const send = async (secret: string): Promise<Response> => {
    const route = await proxyRoute(deps, sandbox)
    const headers = await signedProxyHeaders(deps, sandbox, link, secret)
    for (const [name, value] of request.headers) {
      if (!DROP_REQUEST.test(name)) {
        headers.set(name, value)
      }
    }
    const appCookies = cookiesForApp(request, located, link.id)
    if (appCookies) {
      headers.set('cookie', appCookies)
    }
    headers.set('x-forwarded-host', url.host)
    headers.set('x-forwarded-proto', 'https')
    if (located.mode === 'path') {
      headers.set('x-forwarded-prefix', located.base.slice(0, -1))
    }
    return (deps.fetch ?? fetch)(`${route}${located.rest}${url.search}`, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      redirect: 'manual',
      // Streams the body through (Node's fetch requires saying so; Workers ignore it).
      duplex: 'half'
    } as RequestInit)
  }
  try {
    upstream = await send(deps.secrets[0]!)
    // A VM booted before a secret rotation holds a key from the previous secret until it restarts.
    const previous = deps.secrets[1]
    if (previous && !hasBody && upstream.status === 404 && upstream.headers.get('x-orca-share-proxy') !== '1') {
      upstream = await send(previous)
    }
  } catch (error) {
    console.log(JSON.stringify({ event: 'share_upstream_failed', sandboxId: sandbox.id, error: String(error).slice(0, 120) }))
    forgetShareLink(link.id)
    return page('unreachable')
  }
  if (upstream.headers.get('x-orca-share-proxy') !== '1' && upstream.status !== 101) {
    // No share proxy behind the route (VM from an older image, or the session just ended).
    console.log(JSON.stringify({ event: 'share_no_proxy', sandboxId: sandbox.id, status: upstream.status }))
    forgetShareLink(link.id)
    return page('unreachable')
  }
  const proxyError = upstream.headers.get('x-orca-share-error')
  if (proxyError) {
    return page(proxyError === 'no_listener' ? 'no_listener' : 'unreachable')
  }
  if (upstream.status === 101) {
    // WebSocket: the upgraded socket goes back to the visitor with the same header filtering.
    return new Response(null, {
      status: 101,
      webSocket: (upstream as Response & { webSocket?: WebSocket | null }).webSocket ?? null,
      headers: visitorHeaders(upstream, located, link)
    } as ResponseInit)
  }
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: visitorHeaders(upstream, located, link) })
}
