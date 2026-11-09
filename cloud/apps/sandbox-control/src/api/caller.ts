// Who is calling the public API: a signed-in desktop (Orca JWT, every scope the role allows) or an
// API key (its scopes, acting as the user who created it, inside the key's account).
import { authenticateDesktop, readBearer, type OrgRole, type SandboxCaller } from '../auth'
import type { Env } from '../env'
import { ADMIN_SCOPES, API_SCOPES, parseScopes, resolveApiKey, type ApiKeyKind, type ApiScope } from './keys'

export type ApiCaller = SandboxCaller & {
  scopes: ReadonlySet<ApiScope>
  via: 'session' | ApiKeyKind
  keyId?: string
  /** Workspace tokens: the VM the token was minted for (its workspaces are siblings). */
  sandboxId?: string
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
    this.name = 'ApiError'
  }
}

export function isAdmin(caller: { orgId?: string; orgRole?: OrgRole }): boolean {
  // A personal account is administered by its only user.
  return !caller.orgId || caller.orgRole === 'owner' || caller.orgRole === 'admin'
}

export function scopesForRole(caller: { orgId?: string; orgRole?: OrgRole }): ApiScope[] {
  return API_SCOPES.filter((scope) => !ADMIN_SCOPES.has(scope) || isAdmin(caller))
}

export async function authenticateApi(env: Env, request: Request, now: number): Promise<ApiCaller | null> {
  const bearer = readBearer(request.headers.get('authorization'))
  if (!bearer) {
    return null
  }
  if (bearer.startsWith('orca_')) {
    const key = await resolveApiKey(env.SANDBOX_DB, bearer, now)
    if (!key || key.kind === 'oauth_refresh') {
      return null
    }
    const orgId = key.account_id.startsWith('org:') ? key.account_id.slice(4) : key.account_id.startsWith('dev:org:') ? key.account_id.slice(8) : undefined
    const role = key.creator_role ?? undefined
    // A key never exceeds what its creator's role allowed when it was made.
    const allowed = new Set(scopesForRole({ orgId, orgRole: role }))
    return {
      userId: key.created_by,
      accountId: key.account_id,
      ...(orgId ? { orgId, ...(role ? { orgRole: role } : {}) } : {}),
      ...(key.account_id.startsWith('dev:') ? { dev: true } : {}),
      scopes: new Set(parseScopes(key.scopes).filter((scope) => allowed.has(scope))),
      via: key.kind,
      keyId: key.id,
      ...(key.sandbox_id ? { sandboxId: key.sandbox_id } : {})
    }
  }
  const session = await authenticateDesktop(env, request, now)
  return session ? { ...session, scopes: new Set(scopesForRole(session)), via: 'session' } : null
}

export function requireScope(caller: ApiCaller, scope: ApiScope): void {
  if (!caller.scopes.has(scope)) {
    throw new ApiError(403, 'insufficient_scope', scope)
  }
}

export function requireAdmin(caller: ApiCaller): void {
  if (!isAdmin(caller)) {
    throw new ApiError(403, 'forbidden', 'admin_required')
  }
}

/** Audit actor for a caller. */
export function actorOf(caller: ApiCaller): { type: string; id: string } {
  if (caller.via === 'session') {
    return { type: 'user', id: caller.userId }
  }
  const type = { user: 'api_key', workspace: 'workspace_token', oauth: 'mcp', oauth_refresh: 'mcp' }[caller.via]
  return { type, id: caller.keyId ?? caller.userId }
}
