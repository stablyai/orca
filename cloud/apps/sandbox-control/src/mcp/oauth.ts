// OAuth 2.1 authorization server for MCP clients (MCP authorization spec 2025-11-25):
//   RFC 9728 protected resource metadata, RFC 8414 AS metadata, RFC 7591 dynamic client
//   registration, authorization code + PKCE (S256 only), refresh token rotation, RFC 8707
//   resource indicators, RFC 7009 revocation, RFC 9207 `iss` on the redirect.
// Access tokens are api_keys rows (kind=oauth, 1h, audience = this MCP resource); refresh tokens are
// kind=oauth_refresh (30d, single use). Every token from one authorization code shares a family_id:
// replaying a used code or a rotated refresh token revokes the whole family.
//
// How the user proves who they are on /oauth/authorize: login.onorca.dev only accepts its own
// first-party desktop client with loopback redirects (verified: a hosted redirect_uri answers
// invalid_redirect_uri), so it cannot front a third-party flow yet. Until it can, the consent page
// takes an Orca credential the user already holds: a one-time approval code minted by the signed-in
// desktop (POST /v1/oauth-approvals, 10 min, single use) or an `orca_sk_` API key. The grant never
// exceeds that credential's scopes. To switch to the login service later, see consent.ts.
import type { OrgRole } from '../auth'
import { audit, consumeRate, RateLimitedError } from '../api/audit'
import { scopesForRole } from '../api/caller'
import { API_SCOPES, mintApiKey, parseScopes, randomId, randomToken, resolveApiKey, sha256Hex, type ApiKeyRow, type ApiScope } from '../api/keys'
import { consentPage, CSRF_COOKIE, errorPage, type ConsentView } from './consent'

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000
export const REFRESH_TOKEN_TTL_MS = 30 * 86_400_000
const CODE_TTL_MS = 5 * 60_000
const APPROVAL_TTL_MS = 10 * 60_000
const MAX_REDIRECT_URIS = 10
const REGISTRATIONS_PER_MINUTE_PER_IP = 10
const CONSENTS_PER_MINUTE_PER_IP = 20
const TOKENS_PER_MINUTE_PER_CLIENT = 60

/** What an MCP client gets when it asks for nothing specific: everything but admin and project edits. */
export const DEFAULT_MCP_SCOPES: readonly ApiScope[] = ['workspaces:read', 'workspaces:write', 'messages:write', 'projects:read', 'routines:read', 'routines:write']

export const SCOPE_LABELS: Record<ApiScope, string> = {
  'workspaces:read': 'See your workspaces and the agent sessions in them',
  'workspaces:write': 'Create, sleep, wake, archive and destroy workspaces',
  'messages:write': 'Send messages and tasks to agents in your workspaces',
  'projects:read': 'See your projects',
  'projects:write': 'Create and change projects',
  'routines:read': 'See your routines and their runs',
  'routines:write': 'Run, create and change routines',
  'audit:read': "Read your organization's audit log"
}

export type OAuthEnv = { db: D1Database; now: () => number; origin: string }

export function mcpResource(origin: string): string {
  return `${origin}/mcp`
}

export function protectedResourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version', 'access-control-allow-methods': 'GET, POST, OPTIONS' }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', pragma: 'no-cache', ...CORS, ...headers } })
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status)
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    authorization_servers: [origin],
    scopes_supported: [...API_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'Orca Cloud',
    resource_documentation: `${origin}/docs`
  }
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [...API_SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
    service_documentation: `${origin}/docs`
  }
}

// --- Dynamic client registration (RFC 7591) ---------------------------------------------------

type ClientRow = { client_id: string; client_name: string | null; redirect_uris: string; created_at: number }

/** https anywhere, http only on loopback (native apps, RFC 8252), or a private-use URI scheme. */
export function validRedirectUri(value: string): boolean {
  if (value.length > 2000) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.hash || url.username || url.password) return false
  if (url.protocol === 'https:') return true
  if (url.protocol === 'http:') return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  // Private-use schemes look like reverse DNS (cursor://, com.example.app:/cb); never script-y ones.
  const scheme = url.protocol.slice(0, -1).toLowerCase()
  return /^[a-z][a-z0-9+.-]{1,63}$/.test(scheme) && !['javascript', 'data', 'file', 'blob', 'vbscript', 'about', 'ws', 'wss', 'ftp'].includes(scheme)
}

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Control and bidi-override characters could spoof the consent page.
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, '').trim().slice(0, 80)
  return name || null
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown'
}

async function limited(db: D1Database, bucket: string, limit: number, now: number): Promise<Response | null> {
  try {
    await consumeRate(db, bucket, limit, now)
    return null
  } catch (error) {
    if (error instanceof RateLimitedError) {
      return json({ error: 'slow_down', error_description: 'Too many requests' }, 429, { 'retry-after': String(error.retryAfterSeconds) })
    }
    throw error
  }
}

export async function registerClient(request: Request, env: OAuthEnv): Promise<Response> {
  const now = env.now()
  const slow = await limited(env.db, `oauth-register:${clientIp(request)}`, REGISTRATIONS_PER_MINUTE_PER_IP, now)
  if (slow) return slow
  let body: Record<string, unknown>
  try {
    const text = await request.text()
    if (text.length > 16_384) throw new SyntaxError('too large')
    body = JSON.parse(text)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError('not an object')
  } catch {
    return oauthError('invalid_client_metadata', 'Body must be a JSON object')
  }
  const uris = body.redirect_uris
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every((u) => typeof u === 'string' && validRedirectUri(u))) {
    return oauthError('invalid_redirect_uri', 'redirect_uris must list 1-10 https, loopback http or private-use scheme URIs without fragments')
  }
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ['authorization_code', 'refresh_token']
  if (!grantTypes.every((g) => g === 'authorization_code' || g === 'refresh_token')) {
    return oauthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported')
  }
  const responseTypes = Array.isArray(body.response_types) ? body.response_types : ['code']
  if (!responseTypes.every((r) => r === 'code')) {
    return oauthError('invalid_client_metadata', 'Only the code response type is supported')
  }
  const clientId = randomId('mcpc')
  const name = cleanName(body.client_name)
  await env.db
    .prepare('INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)')
    .bind(clientId, name, JSON.stringify(uris), now)
    .run()
  // Public clients only (PKCE is the proof); a requested client_secret_* method is overridden.
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name ?? undefined,
      redirect_uris: uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    },
    201
  )
}

async function getClient(db: D1Database, clientId: string | null): Promise<(ClientRow & { uris: string[] }) | null> {
  if (!clientId || !/^mcpc_[A-Za-z0-9]{20}$/.test(clientId)) return null
  const row = await db.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first<ClientRow>()
  return row ? { ...row, uris: JSON.parse(row.redirect_uris) as string[] } : null
}

// --- Authorization endpoint ------------------------------------------------------------------

type AuthorizeParams = {
  clientId: string
  redirectUri: string
  state: string | null
  codeChallenge: string
  scopes: ApiScope[]
  resource: string
}

function redirectWith(redirectUri: string, params: Record<string, string | null>): Response {
  const target = new URL(redirectUri)
  for (const [key, value] of Object.entries(params)) {
    if (value !== null) target.searchParams.set(key, value)
  }
  return new Response(null, { status: 302, headers: { location: target.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
}

function sameResource(value: string, origin: string): boolean {
  return value.replace(/\/+$/, '') === mcpResource(origin)
}

/**
 * Validates an authorization request. Client and redirect_uri problems are shown on our own page
 * (never redirected: that would be an open redirect); everything else goes back to the client.
 */
async function readAuthorizeRequest(
  params: URLSearchParams,
  env: OAuthEnv
): Promise<{ ok: AuthorizeParams; client: ClientRow } | { page: Response } | { redirect: Response }> {
  const client = await getClient(env.db, params.get('client_id'))
  if (!client) {
    return { page: errorPage('Unknown application', 'This sign-in link names an application that is not registered with Orca Cloud. Start again from the app.', 400) }
  }
  const redirectUri = params.get('redirect_uri') ?? (client.uris.length === 1 ? client.uris[0] : null)
  // Exact string match against the registration (OAuth 2.1 §2.3.1); no prefix or port wildcards.
  if (!redirectUri || !client.uris.includes(redirectUri)) {
    return { page: errorPage('Invalid redirect', 'The return address in this sign-in link does not match the one the application registered.', 400) }
  }
  const state = params.get('state')
  const back = (error: string, description: string) => ({
    redirect: redirectWith(redirectUri, { error, error_description: description, state, iss: env.origin })
  })
  if (params.get('response_type') !== 'code') return back('unsupported_response_type', 'response_type must be code')
  const challenge = params.get('code_challenge') ?? ''
  if (params.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) {
    return back('invalid_request', 'PKCE with code_challenge_method=S256 is required')
  }
  const resource = params.get('resource')
  if (resource !== null && !sameResource(resource, env.origin)) {
    return back('invalid_target', `resource must be ${mcpResource(env.origin)}`)
  }
  const requested = params.get('scope')
  const scopes = requested === null || requested.trim() === '' ? [...DEFAULT_MCP_SCOPES] : parseScopes(requested)
  if (scopes.length === 0) return back('invalid_scope', 'No supported scope requested')
  return { ok: { clientId: client.client_id, redirectUri, state, codeChallenge: challenge, scopes: [...new Set(scopes)], resource: mcpResource(env.origin) }, client }
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=')
    if (at > 0) cookies.set(part.slice(0, at).trim(), part.slice(at + 1).trim())
  }
  return cookies
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function redirectTarget(redirectUri: string): { host: string; local: boolean; formAction: string } {
  const url = new URL(redirectUri)
  const local = url.protocol === 'http:' || url.protocol === 'https:' ? ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) : true
  const special = url.protocol === 'http:' || url.protocol === 'https:'
  return { host: special ? url.host : `${url.protocol}//`, local, formAction: special ? url.origin : url.protocol }
}

export async function authorize(request: Request, url: URL, env: OAuthEnv): Promise<Response> {
  if (request.method === 'GET') {
    const parsed = await readAuthorizeRequest(url.searchParams, env)
    if ('page' in parsed) return parsed.page
    if ('redirect' in parsed) return parsed.redirect
    const csrf = randomToken(32)
    return consentPage(viewFor(parsed.ok, parsed.client, csrf, null), csrf, redirectTarget(parsed.ok.redirectUri).formAction)
  }
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'GET, POST' } })
  }
  // Same-origin form posts only (CSRF defence in depth on top of the double-submit cookie).
  const origin = request.headers.get('origin')
  if (origin !== null && origin !== env.origin) {
    return errorPage('Request blocked', 'This approval did not come from the Orca Cloud page.', 403)
  }
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get('content-type') ?? '')) {
    return errorPage('Request blocked', 'Unexpected form encoding.', 400)
  }
  const form = new URLSearchParams(await request.text())
  const parsed = await readAuthorizeRequest(form, env)
  if ('page' in parsed) return parsed.page
  if ('redirect' in parsed) return parsed.redirect
  const cookie = parseCookies(request.headers.get('cookie')).get(CSRF_COOKIE) ?? ''
  const csrf = form.get('csrf') ?? ''
  if (!/^[A-Za-z0-9]{32}$/.test(csrf) || !timingSafeEqual(cookie, csrf)) {
    return errorPage('Request expired', 'This approval page expired or was opened in another browser. Start the connection again from the app.', 403)
  }
  const { ok: req, client } = parsed
  if (form.get('decision') !== 'approve') {
    return redirectWith(req.redirectUri, { error: 'access_denied', error_description: 'The user denied access', state: req.state, iss: env.origin })
  }
  const now = env.now()
  const slow = await limited(env.db, `oauth-consent:${clientIp(request)}`, CONSENTS_PER_MINUTE_PER_IP, now)
  if (slow) {
    return errorPage('Too many attempts', 'Wait a minute and try again.', 429)
  }
  const grantor = await resolveGrantor(env.db, (form.get('credential') ?? '').trim(), now)
  if (!grantor) {
    const fresh = randomToken(32)
    return consentPage(viewFor(req, client, fresh, 'That approval code or API key is not valid (it may have expired or been used). Get a new one from Orca.'), fresh, redirectTarget(req.redirectUri).formAction, 401)
  }
  // Only what was requested, what the user left ticked, and what the credential itself may do.
  const ticked = new Set(form.getAll('scope'))
  const scopes = req.scopes.filter((scope) => ticked.has(scope) && grantor.scopes.has(scope))
  if (scopes.length === 0) {
    return redirectWith(req.redirectUri, { error: 'invalid_scope', error_description: 'None of the requested scopes could be granted', state: req.state, iss: env.origin })
  }
  const code = randomToken(43)
  const familyId = randomId('fam')
  await env.db
    .prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, account_id, user_id, creator_role, scopes, redirect_uri, code_challenge, resource, expires_at, family_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(await sha256Hex(code), req.clientId, grantor.accountId, grantor.userId, grantor.role, scopes.join(' '), req.redirectUri, req.codeChallenge, req.resource, now + CODE_TTL_MS, familyId, now)
    .run()
  await audit(
    env.db,
    { accountId: grantor.accountId, type: 'mcp', id: req.clientId, userId: grantor.userId },
    { action: 'mcp.authorize', targetType: 'oauth_client', targetId: req.clientId, detail: { client: client.client_name, scopes, via: grantor.via, redirectHost: redirectTarget(req.redirectUri).host } },
    now
  )
  return redirectWith(req.redirectUri, { code, state: req.state, iss: env.origin })
}

function viewFor(req: AuthorizeParams, client: ClientRow, csrf: string, error: string | null): ConsentView {
  const target = redirectTarget(req.redirectUri)
  return {
    clientName: client.client_name,
    clientId: client.client_id,
    redirectHost: target.host,
    redirectIsLocal: target.local,
    registeredAt: client.created_at,
    scopes: req.scopes.map((scope) => ({ scope, label: SCOPE_LABELS[scope] })),
    hidden: {
      response_type: 'code',
      client_id: req.clientId,
      redirect_uri: req.redirectUri,
      code_challenge: req.codeChallenge,
      code_challenge_method: 'S256',
      resource: req.resource,
      scope: req.scopes.join(' '),
      ...(req.state !== null ? { state: req.state } : {}),
      csrf
    },
    error
  }
}

type Grantor = { accountId: string; userId: string; role: OrgRole | null; scopes: Set<ApiScope>; via: 'approval_code' | 'api_key' }

function orgOf(accountId: string): string | undefined {
  return accountId.startsWith('org:') ? accountId.slice(4) : accountId.startsWith('dev:org:') ? accountId.slice(8) : undefined
}

/** The person approving: a desktop-minted approval code (single use) or one of their API keys. */
async function resolveGrantor(db: D1Database, credential: string, now: number): Promise<Grantor | null> {
  if (/^orca_ap_[A-Za-z0-9]{32}$/.test(credential)) {
    const hash = await sha256Hex(credential)
    const claimed = await db
      .prepare('UPDATE oauth_approvals SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING *')
      .bind(now, hash, now)
      .first<{ account_id: string; user_id: string; creator_role: OrgRole | null; scopes: string }>()
    if (!claimed) return null
    return { accountId: claimed.account_id, userId: claimed.user_id, role: claimed.creator_role, scopes: new Set(parseScopes(claimed.scopes)), via: 'approval_code' }
  }
  const key = await resolveApiKey(db, credential, now)
  // Only a person's own key; workspace and OAuth tokens cannot bootstrap new grants.
  if (!key || key.kind !== 'user') return null
  const orgId = orgOf(key.account_id)
  const allowed = new Set(scopesForRole({ orgId, orgRole: key.creator_role ?? undefined }))
  return {
    accountId: key.account_id,
    userId: key.created_by,
    role: key.creator_role,
    scopes: new Set(parseScopes(key.scopes).filter((scope) => allowed.has(scope))),
    via: 'api_key'
  }
}

// --- Token endpoint ----------------------------------------------------------------------------

async function readForm(request: Request): Promise<URLSearchParams> {
  const type = request.headers.get('content-type') ?? ''
  const text = await request.text()
  if (text.length > 16_384) return new URLSearchParams()
  if (/^application\/json\b/i.test(type)) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>
      return new URLSearchParams(Object.entries(body).filter(([, v]) => typeof v === 'string') as [string, string][])
    } catch {
      return new URLSearchParams()
    }
  }
  return new URLSearchParams(text)
}

async function pkceS256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
  return btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function revokeFamily(db: D1Database, familyId: string, now: number): Promise<void> {
  await db.prepare(`UPDATE api_keys SET revoked_at = ?, revoked_by = 'system' WHERE family_id = ? AND revoked_at IS NULL`).bind(now, familyId).run()
}

async function issueTokens(
  env: OAuthEnv,
  grant: { accountId: string; userId: string; role: OrgRole | null; scopes: ApiScope[]; clientId: string; clientName: string | null; familyId: string },
  now: number
): Promise<Response> {
  const name = `MCP · ${grant.clientName ?? grant.clientId}`.slice(0, 100)
  const oauth = { clientId: grant.clientId, audience: mcpResource(env.origin), familyId: grant.familyId }
  const base = { accountId: grant.accountId, createdBy: grant.userId, creatorRole: grant.role, name, scopes: grant.scopes, oauth }
  const access = await mintApiKey(env.db, { ...base, kind: 'oauth', expiresAt: now + ACCESS_TOKEN_TTL_MS }, now)
  const refresh = await mintApiKey(env.db, { ...base, kind: 'oauth_refresh', expiresAt: now + REFRESH_TOKEN_TTL_MS }, now)
  return json({
    access_token: access.secret,
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_MS / 1000,
    refresh_token: refresh.secret,
    scope: grant.scopes.join(' ')
  })
}

type CodeRow = {
  code_hash: string
  client_id: string
  account_id: string
  user_id: string
  creator_role: OrgRole | null
  scopes: string
  redirect_uri: string
  code_challenge: string
  resource: string | null
  expires_at: number
  consumed_at: number | null
  family_id: string | null
}

export async function token(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST', ...CORS } })
  }
  const form = await readForm(request)
  const now = env.now()
  const client = await getClient(env.db, form.get('client_id'))
  if (!client) {
    return oauthError('invalid_client', 'Unknown client_id', 401)
  }
  const slow = await limited(env.db, `oauth-token:${client.client_id}`, TOKENS_PER_MINUTE_PER_CLIENT, now)
  if (slow) return slow
  const resource = form.get('resource')
  if (resource !== null && !sameResource(resource, env.origin)) {
    return oauthError('invalid_target', `resource must be ${mcpResource(env.origin)}`)
  }
  const grantType = form.get('grant_type')

  if (grantType === 'authorization_code') {
    const code = form.get('code') ?? ''
    const verifier = form.get('code_verifier') ?? ''
    if (!/^[A-Za-z0-9]{43}$/.test(code)) return oauthError('invalid_grant', 'Invalid authorization code')
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError('invalid_request', 'code_verifier is required (43-128 characters)')
    const hash = await sha256Hex(code)
    const row = await env.db.prepare('SELECT * FROM oauth_codes WHERE code_hash = ?').bind(hash).first<CodeRow>()
    if (!row || row.client_id !== client.client_id) return oauthError('invalid_grant', 'Invalid authorization code')
    if (row.consumed_at !== null) {
      // A replayed code means it leaked: everything minted from it dies (OAuth 2.1 §4.1.3).
      if (row.family_id) await revokeFamily(env.db, row.family_id, now)
      await audit(env.db, { accountId: row.account_id, type: 'mcp', id: client.client_id, userId: row.user_id }, { action: 'mcp.code_replay', targetType: 'oauth_client', targetId: client.client_id }, now)
      return oauthError('invalid_grant', 'Authorization code already used')
    }
    if (row.expires_at <= now) return oauthError('invalid_grant', 'Authorization code expired')
    if (form.get('redirect_uri') !== null && form.get('redirect_uri') !== row.redirect_uri) return oauthError('invalid_grant', 'redirect_uri does not match')
    if (!timingSafeEqual(await pkceS256(verifier), row.code_challenge)) return oauthError('invalid_grant', 'PKCE verification failed')
    const claimed = await env.db.prepare('UPDATE oauth_codes SET consumed_at = ? WHERE code_hash = ? AND consumed_at IS NULL').bind(now, hash).run()
    if (claimed.meta.changes !== 1) return oauthError('invalid_grant', 'Authorization code already used')
    return issueTokens(
      env,
      { accountId: row.account_id, userId: row.user_id, role: row.creator_role, scopes: parseScopes(row.scopes), clientId: client.client_id, clientName: client.client_name, familyId: row.family_id ?? randomId('fam') },
      now
    )
  }

  if (grantType === 'refresh_token') {
    const presented = form.get('refresh_token') ?? ''
    if (!/^orca_ort_[A-Za-z0-9]{32}$/.test(presented)) return oauthError('invalid_grant', 'Invalid refresh token')
    const row = await env.db.prepare(`SELECT * FROM api_keys WHERE secret_hash = ? AND kind = 'oauth_refresh'`).bind(await sha256Hex(presented)).first<ApiKeyRow>()
    if (!row || row.client_id !== client.client_id) return oauthError('invalid_grant', 'Invalid refresh token')
    if (row.revoked_at !== null) {
      // Rotated tokens are single use: a second use means a copy leaked, so end the whole grant.
      if (row.family_id && row.revoked_by === 'rotated') {
        await revokeFamily(env.db, row.family_id, now)
        await audit(env.db, { accountId: row.account_id, type: 'mcp', id: client.client_id, userId: row.created_by }, { action: 'mcp.refresh_replay', targetType: 'oauth_client', targetId: client.client_id }, now)
      }
      return oauthError('invalid_grant', 'Refresh token revoked')
    }
    if (row.expires_at !== null && row.expires_at <= now) return oauthError('invalid_grant', 'Refresh token expired')
    const rotated = await env.db.prepare(`UPDATE api_keys SET revoked_at = ?, revoked_by = 'rotated' WHERE id = ? AND revoked_at IS NULL`).bind(now, row.id).run()
    if (rotated.meta.changes !== 1) return oauthError('invalid_grant', 'Refresh token revoked')
    const granted = parseScopes(row.scopes)
    const asked = form.get('scope')
    const scopes = asked ? parseScopes(asked).filter((scope) => granted.includes(scope)) : granted
    if (scopes.length === 0) return oauthError('invalid_scope', 'Requested scope exceeds the grant')
    return issueTokens(
      env,
      { accountId: row.account_id, userId: row.created_by, role: row.creator_role, scopes, clientId: client.client_id, clientName: client.client_name, familyId: row.family_id ?? randomId('fam') },
      now
    )
  }

  return oauthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token')
}

/** RFC 7009: revoking either token ends the whole grant. Always 200, even for unknown tokens. */
export async function revoke(request: Request, env: OAuthEnv): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST', ...CORS } })
  }
  const form = await readForm(request)
  const presented = form.get('token') ?? ''
  const clientId = form.get('client_id')
  if (/^orca_(oat|ort)_[A-Za-z0-9]{32}$/.test(presented)) {
    const row = await env.db.prepare(`SELECT * FROM api_keys WHERE secret_hash = ? AND kind IN ('oauth', 'oauth_refresh')`).bind(await sha256Hex(presented)).first<ApiKeyRow>()
    if (row && row.family_id && (clientId === null || clientId === row.client_id)) {
      await revokeFamily(env.db, row.family_id, env.now())
    }
  }
  return json({})
}

// --- Approval codes (minted by the signed-in desktop) ---------------------------------------

export async function mintApproval(
  db: D1Database,
  caller: { accountId: string; userId: string; orgId?: string; orgRole?: OrgRole },
  scopes: ApiScope[],
  now: number
): Promise<{ code: string; expiresAt: number; scopes: ApiScope[] }> {
  const code = `orca_ap_${randomToken(32)}`
  const expiresAt = now + APPROVAL_TTL_MS
  await db
    .prepare('INSERT INTO oauth_approvals (code_hash, account_id, user_id, creator_role, scopes, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(await sha256Hex(code), caller.accountId, caller.userId, caller.orgId ? (caller.orgRole ?? 'member') : null, scopes.join(' '), expiresAt, now)
    .run()
  return { code, expiresAt, scopes }
}
