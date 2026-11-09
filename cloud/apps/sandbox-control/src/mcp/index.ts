// Hosted MCP server: routing for /mcp, the OAuth endpoints and their discovery documents, plus the
// /v1/oauth-approvals API route the desktop uses to approve an MCP client.
import { z } from 'zod'
import { auditCaller } from '../api/audit'
import { ApiError, scopesForRole, type ApiCaller } from '../api/caller'
import { API_SCOPES, type ApiScope } from '../api/keys'
import type { ApiExtension } from '../api/router'
import {
  authorizationServerMetadata,
  authorize,
  DEFAULT_MCP_SCOPES,
  mcpResource,
  mintApproval,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  registerClient,
  revoke,
  token
} from './oauth'
import { handleMcpPost } from './server'

export type McpDeps = {
  /** Public origin of this Worker: the OAuth issuer and the MCP resource's origin. */
  origin: string
  db: D1Database
  now: () => number
  /** Browser origins allowed to call /mcp (besides our own); everything else is refused. */
  allowedOrigins: readonly string[]
  authenticate: (request: Request) => Promise<ApiCaller | null>
  /** The public API for an authenticated caller (router.handleApiAs + the Worker's error mapping). */
  api: (caller: ApiCaller, method: string, path: string, body?: unknown) => Promise<Response>
}

export function isMcpPath(pathname: string): boolean {
  return (
    pathname === '/mcp' ||
    pathname === '/mcp/' ||
    pathname.startsWith('/.well-known/oauth-protected-resource') ||
    pathname === '/.well-known/oauth-authorization-server' ||
    pathname.startsWith('/oauth/')
  )
}

const PUBLIC_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version',
  'access-control-max-age': '600'
}

function metadata(body: unknown): Response {
  return Response.json(body, { headers: { 'cache-control': 'public, max-age=300', ...PUBLIC_CORS } })
}

function mcpCors(origin: string | null): Record<string, string> {
  return origin
    ? {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
        'access-control-expose-headers': 'www-authenticate, mcp-session-id, mcp-protocol-version',
        'access-control-max-age': '600',
        vary: 'origin'
      }
    : {}
}

function unauthorized(origin: string, cors: Record<string, string>, invalidToken: boolean): Response {
  const challenge = [
    'Bearer',
    ` resource_metadata="${protectedResourceMetadataUrl(origin)}"`,
    `, scope="${DEFAULT_MCP_SCOPES.join(' ')}"`,
    invalidToken ? ', error="invalid_token", error_description="The access token is invalid, expired or for another resource"' : ''
  ].join('')
  return Response.json(
    { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } },
    { status: 401, headers: { 'www-authenticate': challenge, 'cache-control': 'no-store', ...cors } }
  )
}

async function handleMcpEndpoint(request: Request, deps: McpDeps): Promise<Response> {
  // DNS-rebinding / cross-site defence: browsers always send Origin; only listed origins pass.
  const requestOrigin = request.headers.get('origin')
  const allowed = requestOrigin === null || requestOrigin === deps.origin || deps.allowedOrigins.includes(requestOrigin)
  if (!allowed) {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } }, { status: 403 })
  }
  const cors = mcpCors(requestOrigin)
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }
  if (request.method !== 'POST') {
    // Stateless server: no standalone SSE stream (GET) and no sessions to end (DELETE).
    return new Response(null, { status: 405, headers: { allow: 'POST, OPTIONS', ...cors } })
  }
  const caller = await deps.authenticate(request)
  if (!caller) {
    return unauthorized(deps.origin, cors, Boolean(request.headers.get('authorization')))
  }
  // RFC 8707: OAuth access tokens only work for the resource they were issued for.
  if (caller.via === 'oauth' && caller.audience !== mcpResource(deps.origin)) {
    return unauthorized(deps.origin, cors, true)
  }
  return handleMcpPost(request, {
    caller,
    headers: cors,
    api: (method, path, body) => deps.api(caller, method, path, body)
  })
}

export async function handleMcpRoutes(request: Request, url: URL, deps: McpDeps): Promise<Response> {
  const path = url.pathname
  if (path === '/mcp' || path === '/mcp/') {
    return handleMcpEndpoint(request, deps)
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: PUBLIC_CORS })
  }
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    return metadata(protectedResourceMetadata(deps.origin))
  }
  if (path === '/.well-known/oauth-authorization-server') {
    return metadata(authorizationServerMetadata(deps.origin))
  }
  const env = { db: deps.db, now: deps.now, origin: deps.origin }
  if (path === '/oauth/register' && request.method === 'POST') {
    return registerClient(request, env)
  }
  if (path === '/oauth/authorize') {
    return authorize(request, url, env)
  }
  if (path === '/oauth/token') {
    return token(request, env)
  }
  if (path === '/oauth/revoke') {
    return revoke(request, env)
  }
  return Response.json({ error: 'not_found' }, { status: 404 })
}

const ApprovalBody = z.object({ scopes: z.array(z.enum(API_SCOPES)).min(1).optional() }).strict()

/**
 * POST /v1/oauth-approvals (signed-in desktop only): a one-time code the user pastes on the MCP
 * consent page to approve a client. Lets the desktop offer "Approve an app" without ever showing
 * a long-lived API key.
 */
export const oauthApprovalsApi: ApiExtension = async (request, url, caller, ctx) => {
  if (url.pathname !== '/v1/oauth-approvals') {
    return null
  }
  if (request.method !== 'POST') {
    throw new ApiError(405, 'method_not_allowed')
  }
  if (caller.via !== 'session') {
    throw new ApiError(403, 'forbidden', 'session_required')
  }
  const parsed = ApprovalBody.safeParse(await ctx.readJson())
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', parsed.error.issues[0]?.message)
  }
  const allowed = new Set<ApiScope>(scopesForRole(caller))
  const requested = parsed.data.scopes ?? [...allowed]
  const denied = requested.filter((scope) => !allowed.has(scope))
  if (denied.length > 0) {
    throw new ApiError(403, 'forbidden', `admin_scope:${denied.join(',')}`)
  }
  const now = ctx.now()
  const approval = await mintApproval(ctx.db, caller, requested, now)
  await auditCaller(ctx.db, caller, { action: 'mcp.approval_create', targetType: 'account', targetId: caller.accountId, detail: { scopes: requested } }, now)
  return Response.json(approval, { status: 201, headers: { 'cache-control': 'no-store' } })
}
