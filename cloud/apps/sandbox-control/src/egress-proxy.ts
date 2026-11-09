// Target of Vercel network-policy `forwardURL` rules. Vercel proves which sandbox sent the request
// with an OIDC token; we swap the VM's placeholder for the real credential and return a normally
// framed response (works around undici hanging on transform-rule responses). Real tokens never
// enter the VM or Vercel's policy store.
import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose'
import type { SandboxRow } from './store'

const VERCEL_OIDC_HOSTNAME = 'oidc.vercel.com'
/** Hosts whose clients are Node (undici); git/curl hosts use transform rules instead. */
export const PROXIED_HOSTS: ReadonlySet<string> = new Set(['api.github.com'])
const DROP_HEADERS = [
  'vercel-forwarded-host',
  'vercel-forwarded-scheme',
  'vercel-forwarded-port',
  'vercel-forwarded-path',
  'vercel-sandbox-oidc-token',
  'host',
  'connection',
  'keep-alive',
  'proxy-authorization',
  'transfer-encoding',
  'upgrade'
]

export type CredentialBroker = {
  /** Authorization header value for `host` on behalf of this sandbox's workspace, or null. */
  authorizationFor(row: SandboxRow, host: string): Promise<string | null>
}

/** Until the GitHub App installation-token minter exists, proxied hosts are refused. */
export const NO_CREDENTIALS: CredentialBroker = { authorizationFor: async () => null }

export type EgressProxyDeps = {
  teamId: string
  projectId: string
  findSandbox: (providerName: string) => Promise<SandboxRow | null>
  placeholdersFor: (row: SandboxRow) => readonly string[]
  credentials: CredentialBroker
  fetch?: typeof fetch
  /** Tests inject a local key set; production fetches `<issuer>/.well-known/jwks`. */
  keysForIssuer?: (issuer: string) => JWTVerifyGetKey
}

const remoteKeys = new Map<string, JWTVerifyGetKey>()
function defaultKeys(issuer: string): JWTVerifyGetKey {
  let keys = remoteKeys.get(issuer)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/.well-known/jwks`))
    remoteKeys.set(issuer, keys)
  }
  return keys
}

function deny(reason: string): Response {
  return new Response(reason, { status: 403, headers: { 'content-type': 'text/plain' } })
}

/** The audience Vercel signs: the forwardURL, i.e. this request's URL minus the forwarded path. */
function forwardAudience(requestUrl: URL, forwardedPath: string): string {
  const strip = (path: string) => path.replace(/\/+$/, '') || '/'
  const suffix = strip(new URL(forwardedPath, requestUrl.origin).pathname)
  let pathname = strip(requestUrl.pathname)
  if (suffix !== '/' && pathname.endsWith(suffix)) {
    pathname = strip(pathname.slice(0, -suffix.length))
  }
  return pathname === '/' ? requestUrl.origin : requestUrl.origin + pathname
}

export async function handleEgressProxy(request: Request, deps: EgressProxyDeps): Promise<Response> {
  const host = request.headers.get('vercel-forwarded-host')?.toLowerCase()
  const scheme = request.headers.get('vercel-forwarded-scheme')
  const port = request.headers.get('vercel-forwarded-port')
  const path = request.headers.get('vercel-forwarded-path')
  const token = request.headers.get('vercel-sandbox-oidc-token')
  if (!host || !scheme || !port || !path || !token || !path.startsWith('/')) {
    return deny('missing_proxy_headers')
  }
  if (!PROXIED_HOSTS.has(host) || scheme !== 'https' || port !== '443') {
    return deny('host_not_proxied')
  }
  let claims: Record<string, unknown>
  try {
    const issuer = String(decodeJwt(token).iss ?? '')
    const issuerUrl = new URL(issuer)
    if (issuerUrl.protocol !== 'https:' || issuerUrl.hostname !== VERCEL_OIDC_HOSTNAME) {
      return deny('bad_issuer')
    }
    const verified = await jwtVerify(token, (deps.keysForIssuer ?? defaultKeys)(issuer), {
      issuer,
      audience: forwardAudience(new URL(request.url), path),
      algorithms: ['RS256'],
      clockTolerance: 60
    })
    claims = verified.payload
  } catch {
    return deny('bad_oidc_token')
  }
  if (claims.team_id !== deps.teamId || claims.project_id !== deps.projectId) {
    return deny('foreign_sandbox')
  }
  const name = typeof claims.sandbox_name === 'string' ? claims.sandbox_name : null
  const row = name ? await deps.findSandbox(name) : null
  if (!row || row.status !== 'running') {
    return deny('sandbox_not_running')
  }
  if (!deps.placeholdersFor(row).includes(request.headers.get('authorization') ?? '')) {
    return deny('placeholder_missing')
  }
  const authorization = await deps.credentials.authorizationFor(row, host)
  if (!authorization) {
    return deny('credential_unavailable')
  }
  const headers = new Headers(request.headers)
  for (const name of DROP_HEADERS) {
    headers.delete(name)
  }
  headers.set('authorization', authorization)
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const upstream = await (deps.fetch ?? fetch)(`https://${host}${path}`, {
    method: request.method,
    headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    redirect: 'manual'
  })
  // Re-wrapping lets the runtime frame the body (content-length or chunked) for the VM's client.
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
}
