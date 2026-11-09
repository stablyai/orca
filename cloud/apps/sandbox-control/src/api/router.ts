// Public, versioned REST API (also used by the desktop's API keys and routines settings, the MCP
// server and the `orca` CLI). Every route authenticates with an Orca session token or an API key,
// is rate limited per caller, and every mutation is audited. See openapi.ts for the contract.
import { z } from 'zod'
import { GuardrailError, consumeCreateToken } from '../guardrails'
import type { LifecycleDeps } from '../lifecycle'
import { AGENTS } from './vm-agent'
import { ApiError, actorOf, authenticateApi, isAdmin, requireAdmin, requireScope, scopesForRole, type ApiCaller } from './caller'
import { auditCaller, auditView, consumeRate, listAudit, rateHeaders, RateLimitedError, type RateLimit } from './audit'
import { API_SCOPES, ADMIN_SCOPES, apiKeyView, getApiKey, listApiKeys, mintApiKey, revokeApiKey, type ApiScope } from './keys'
import { deliverMessage, getMessage, listMessages, MAX_MESSAGE_CHARS, messageView, queueMessage } from './messages'
import { getAccountSettings, putAccountSettings } from './settings'
import { listSessions, readSession, VmAgentError } from './vm-agent'
import {
  archiveProject,
  archiveWorkspace,
  createWorkspace,
  destroyWorkspace,
  getProject,
  getWorkspace,
  insertProject,
  listProjects,
  listWorkspaces,
  projectView,
  sleepWorkspace,
  updateProject,
  wakeWorkspace,
  workspaceView,
  type WorkspaceOrigin,
  type WorkspaceRow
} from './workspaces'

export type ApiContext = {
  db: D1Database
  now: () => number
  /** Null when the Worker cannot run sandboxes (missing provider config); workspace routes answer 503. */
  life: LifecycleDeps | null
  waitUntil: (promise: Promise<unknown>) => void
  readJson: () => Promise<unknown>
  /** Extra route groups mounted under the same auth (routines). */
  extensions?: ApiExtension[]
}

export type ApiExtension = (request: Request, url: URL, caller: ApiCaller, ctx: ApiContext) => Promise<Response | null>

const REQUESTS_PER_MINUTE = 120
const MESSAGES_PER_MINUTE = 30

const Name = z.string().trim().min(1).max(100)
const RepoUrl = z.url({ protocol: /^https$/ }).max(2048)
const Ref = z.string().min(1).max(255)
const Size = z.enum(['standard', 'large'])
const Region = z.string().regex(/^[a-z]{3}[0-9]$/)

const CreateKeyBody = z
  .object({
    name: Name,
    scopes: z.array(z.enum(API_SCOPES)).min(1),
    expiresInDays: z.number().int().min(1).max(365).optional()
  })
  .strict()
const SettingsBody = z.object({ vmCliEnabled: z.boolean() }).strict()
const ProjectBody = z
  .object({
    name: Name,
    repo: z.object({ url: RepoUrl, ref: Ref.optional() }).strict().optional(),
    environment: z.object({ machineSize: Size.optional(), region: Region.optional(), buildId: z.string().max(128).nullable().optional() }).strict().optional()
  })
  .strict()
const ProjectPatch = ProjectBody.partial().strict()
const CreateWorkspaceBody = z
  .object({
    name: Name.optional(),
    projectId: z.string().max(64).optional(),
    repo: z.object({ url: RepoUrl, ref: Ref.optional() }).strict().optional(),
    machineSize: Size.optional(),
    region: Region.optional(),
    /** Optional first message: queued and delivered as soon as the VM is up. */
    message: z.object({ text: z.string().min(1).max(MAX_MESSAGE_CHARS), agent: z.enum(AGENTS).optional() }).strict().optional()
  })
  .strict()
const MessageBody = z
  .object({
    text: z.string().min(1).max(MAX_MESSAGE_CHARS),
    agent: z.enum(AGENTS).optional(),
    /** A session handle from GET /sessions or a previous message: continue that conversation. */
    session: z.string().regex(/^term_[A-Za-z0-9-]{1,80}$/).optional()
  })
  .strict()

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } })
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new ApiError(400, 'invalid_request', issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : undefined)
  }
  return result.data
}

function requireLife(ctx: ApiContext): LifecycleDeps {
  if (!ctx.life) {
    throw new ApiError(503, 'not_configured')
  }
  return ctx.life
}

/** Workspace tokens see their own VM and the siblings it created; everyone else sees the account. */
function assertVisible(caller: ApiCaller, row: WorkspaceRow): void {
  if (caller.via === 'workspace' && row.id !== caller.sandboxId && row.origin_ref !== caller.sandboxId) {
    throw new ApiError(404, 'not_found')
  }
}

function originFor(caller: ApiCaller): { origin: WorkspaceOrigin; originRef: string | null } {
  if (caller.via === 'workspace') {
    return { origin: 'vm', originRef: caller.sandboxId ?? null }
  }
  if (caller.via === 'oauth') {
    return { origin: 'mcp', originRef: caller.keyId ?? null }
  }
  return { origin: 'api', originRef: caller.via === 'user' ? (caller.keyId ?? null) : null }
}

function messageBucket(caller: ApiCaller): string {
  return caller.via === 'workspace' ? `msg:ws:${caller.sandboxId}` : `msg:${caller.accountId}:${caller.userId}`
}

export function isApiPath(pathname: string): boolean {
  return /^\/v1\/(me|api-keys|settings|audit|projects|workspaces|routines|oauth-approvals|oauth-grants)(\/|$)/.test(pathname)
}

export async function handleApi(request: Request, url: URL, env: Parameters<typeof authenticateApi>[0], ctx: ApiContext): Promise<Response> {
  let caller: ApiCaller | null
  try {
    caller = await authenticateApi(env, request, ctx.now())
  } catch (error) {
    return apiError(error)
  }
  // MCP OAuth access tokens are audience-bound to the MCP server (RFC 8707): not REST credentials.
  if (!caller || caller.via === 'oauth') {
    return json({ error: 'unauthorized' }, 401, { 'www-authenticate': caller ? 'Bearer error="invalid_token"' : 'Bearer' })
  }
  return handleApiAs(caller, request, url, ctx)
}

/** The API for an already-authenticated caller (the MCP server dispatches tool calls here). */
export async function handleApiAs(caller: ApiCaller, request: Request, url: URL, ctx: ApiContext): Promise<Response> {
  let rate: RateLimit | null = null
  try {
    if (caller.via === 'workspace' && !(await getAccountSettings(ctx.db, caller.accountId)).vmCliEnabled) {
      // The org turned in-VM access off: every outstanding workspace token stops working at once.
      throw new ApiError(403, 'forbidden', 'vm_cli_disabled')
    }
    rate = await consumeRate(ctx.db, `api:${caller.keyId ?? `user:${caller.accountId}:${caller.userId}`}`, REQUESTS_PER_MINUTE, ctx.now())
    const response = await route(request, url, caller, ctx)
    for (const [name, value] of Object.entries(rateHeaders(rate))) {
      response.headers.set(name, value)
    }
    return response
  } catch (error) {
    return apiError(error, rate)
  }
}

export function apiError(error: unknown, rate: RateLimit | null = null): Response {
  const headers = rate ? rateHeaders(rate) : {}
  if (error instanceof RateLimitedError) {
    return json({ error: 'rate_limited' }, 429, { ...rateHeaders(error.rate), 'retry-after': String(error.retryAfterSeconds) })
  }
  if (error instanceof ApiError) {
    return json(error.reason ? { error: error.code, reason: error.reason } : { error: error.code }, error.status, headers)
  }
  if (error instanceof SyntaxError) {
    return json({ error: 'invalid_json' }, 400, headers)
  }
  if (error instanceof GuardrailError && error.code === 'rate_limited') {
    return json({ error: 'rate_limited', reason: 'workspace_creates' }, 429, { ...headers, 'retry-after': String(error.retryAfterSeconds ?? 60) })
  }
  if (error instanceof VmAgentError) {
    return json({ error: 'workspace_unavailable', reason: error.code }, 502, headers)
  }
  // Lifecycle, guardrail, billing and provider errors keep the desktop's mapping (index.ts).
  throw error
}

async function route(request: Request, url: URL, caller: ApiCaller, ctx: ApiContext): Promise<Response> {
  const parts = url.pathname.split('/').filter(Boolean).slice(1) // drop "v1"
  const [resource, id, sub, subId] = parts
  const method = request.method
  const now = ctx.now()

  for (const extension of ctx.extensions ?? []) {
    const handled = await extension(request, url, caller, ctx)
    if (handled) {
      return handled
    }
  }

  if (resource === 'me' && !id && method === 'GET') {
    return json({
      accountId: caller.accountId,
      userId: caller.userId,
      orgId: caller.orgId ?? null,
      role: caller.orgId ? (caller.orgRole ?? 'member') : 'owner',
      via: caller.via,
      scopes: [...caller.scopes],
      ...(caller.sandboxId ? { workspaceId: caller.sandboxId } : {})
    })
  }

  if (resource === 'api-keys') {
    if (caller.via !== 'session') {
      // Keys are made and revoked by a signed-in person, never by another key.
      throw new ApiError(403, 'forbidden', 'session_required')
    }
    if (!id && method === 'GET') {
      const rows = await listApiKeys(ctx.db, caller.accountId, isAdmin(caller) ? {} : { createdBy: caller.userId })
      return json({ keys: rows.map(apiKeyView), availableScopes: scopesForRole(caller) })
    }
    if (!id && method === 'POST') {
      const body = parse(CreateKeyBody, await ctx.readJson())
      const forbidden = body.scopes.filter((scope) => ADMIN_SCOPES.has(scope) && !isAdmin(caller))
      if (forbidden.length > 0) {
        throw new ApiError(403, 'forbidden', `admin_scope:${forbidden.join(',')}`)
      }
      const minted = await mintApiKey(
        ctx.db,
        {
          accountId: caller.accountId,
          createdBy: caller.userId,
          creatorRole: caller.orgId ? (caller.orgRole ?? 'member') : null,
          name: body.name,
          scopes: body.scopes as ApiScope[],
          expiresAt: body.expiresInDays ? now + body.expiresInDays * 86_400_000 : null
        },
        now
      )
      await auditCaller(ctx.db, caller, { action: 'api_key.create', targetType: 'api_key', targetId: minted.row.id, detail: { name: body.name, scopes: body.scopes } }, now)
      // The only time the secret is ever returned.
      return json({ key: apiKeyView(minted.row), secret: minted.secret }, 201)
    }
    if (id && !sub && method === 'DELETE') {
      const key = await getApiKey(ctx.db, id)
      if (!key || key.account_id !== caller.accountId || key.kind !== 'user' || (key.created_by !== caller.userId && !isAdmin(caller))) {
        throw new ApiError(404, 'not_found')
      }
      const revoked = await revokeApiKey(ctx.db, id, caller.userId, now)
      if (revoked) {
        await auditCaller(ctx.db, caller, { action: 'api_key.revoke', targetType: 'api_key', targetId: id, detail: { name: key.name } }, now)
      }
      return json({ revoked: true })
    }
  }

  if (resource === 'settings' && !id) {
    if (method === 'GET') {
      return json({ settings: await getAccountSettings(ctx.db, caller.accountId), canEdit: isAdmin(caller) && caller.via === 'session' })
    }
    if (method === 'PUT') {
      if (caller.via !== 'session') {
        throw new ApiError(403, 'forbidden', 'session_required')
      }
      requireAdmin(caller)
      const body = parse(SettingsBody, await ctx.readJson())
      const settings = await putAccountSettings(ctx.db, caller.accountId, body, caller.userId, now)
      await auditCaller(ctx.db, caller, { action: 'settings.update', targetType: 'account', targetId: caller.accountId, detail: body }, now)
      return json({ settings, canEdit: true })
    }
  }

  if (resource === 'audit' && !id && method === 'GET') {
    requireScope(caller, 'audit:read')
    requireAdmin(caller)
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 50) || 50))
    const before = Number(url.searchParams.get('before')) || undefined
    const rows = await listAudit(ctx.db, caller.accountId, { before, limit })
    return json({ entries: rows.map(auditView), nextBefore: rows.length === limit ? rows.at(-1)!.created_at : null })
  }

  if (resource === 'projects') {
    if (!id && method === 'GET') {
      requireScope(caller, 'projects:read')
      return json({ projects: (await listProjects(ctx.db, caller.accountId)).map(projectView) })
    }
    if (!id && method === 'POST') {
      requireScope(caller, 'projects:write')
      const body = parse(ProjectBody, await ctx.readJson())
      const row = await insertProject(
        ctx.db,
        {
          account_id: caller.accountId,
          name: body.name,
          repo_url: body.repo?.url ?? null,
          default_ref: body.repo?.ref ?? null,
          machine_size: body.environment?.machineSize ?? 'standard',
          region: body.environment?.region ?? null,
          build_id: body.environment?.buildId ?? null,
          created_by: caller.userId
        },
        now
      )
      await auditCaller(ctx.db, caller, { action: 'project.create', targetType: 'project', targetId: row.id, detail: { name: row.name } }, now)
      return json({ project: projectView(row) }, 201)
    }
    if (id && !sub) {
      const row = await getProject(ctx.db, caller.accountId, id)
      if (method === 'GET') {
        requireScope(caller, 'projects:read')
        return json({ project: projectView(row) })
      }
      if (method === 'PATCH') {
        requireScope(caller, 'projects:write')
        const body = parse(ProjectPatch, await ctx.readJson())
        const next = await updateProject(
          ctx.db,
          row,
          {
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.repo !== undefined ? { repo_url: body.repo.url, default_ref: body.repo.ref ?? null } : {}),
            ...(body.environment?.machineSize !== undefined ? { machine_size: body.environment.machineSize } : {}),
            ...(body.environment?.region !== undefined ? { region: body.environment.region } : {}),
            ...(body.environment?.buildId !== undefined ? { build_id: body.environment.buildId } : {})
          },
          now
        )
        await auditCaller(ctx.db, caller, { action: 'project.update', targetType: 'project', targetId: id, detail: { fields: Object.keys(body) } }, now)
        return json({ project: projectView(next) })
      }
      if (method === 'DELETE') {
        requireScope(caller, 'projects:write')
        await archiveProject(ctx.db, row, now)
        await auditCaller(ctx.db, caller, { action: 'project.delete', targetType: 'project', targetId: id }, now)
        return json({ deleted: true })
      }
    }
  }

  if (resource === 'workspaces') {
    if (!id && method === 'GET') {
      requireScope(caller, 'workspaces:read')
      const include = new Set((url.searchParams.get('include') ?? '').split(','))
      const rows = await listWorkspaces(ctx.db, caller.accountId, {
        includeHidden: include.has('hidden'),
        includeArchived: include.has('archived'),
        projectId: url.searchParams.get('projectId') ?? undefined,
        ...(caller.via === 'workspace' ? { originRef: caller.sandboxId } : {}),
        limit: 200
      })
      return json({ workspaces: rows.map(workspaceView) })
    }
    if (!id && method === 'POST') {
      requireScope(caller, 'workspaces:write')
      const life = requireLife(ctx)
      const body = parse(CreateWorkspaceBody, await ctx.readJson())
      if (body.message) {
        requireScope(caller, 'messages:write')
        await consumeRate(ctx.db, messageBucket(caller), MESSAGES_PER_MINUTE, now)
      }
      const project = body.projectId ? await getProject(ctx.db, caller.accountId, body.projectId) : null
      await consumeCreateToken(life.db, life.config.guardrails!, caller.accountId, now)
      const { origin, originRef } = originFor(caller)
      const started = performance.now()
      const row = await createWorkspace(life, caller, {
        name: body.name,
        project,
        repo: body.repo,
        machineSize: body.machineSize,
        region: body.region,
        origin,
        originRef
      })
      await auditCaller(ctx.db, caller, { action: 'workspace.create', targetType: 'workspace', targetId: row.id, detail: { projectId: project?.id ?? null, origin, ms: Math.round(performance.now() - started) } }, ctx.now())
      let message = null
      if (body.message) {
        const queued = await queueMessage(ctx.db, { workspace: row, sentBy: caller.userId, agent: body.message.agent ?? 'claude', text: body.message.text }, ctx.now())
        await auditCaller(ctx.db, caller, { action: 'workspace.message', targetType: 'workspace', targetId: row.id, detail: { messageId: queued.id, chars: body.message.text.length, continues: false } }, ctx.now())
        ctx.waitUntil(deliverMessage(life, queued))
        message = messageView(queued)
      }
      return json({ workspace: workspaceView(row), ...(message ? { message } : {}) }, 201)
    }
    if (id) {
      const row = await getWorkspace(ctx.db, caller.accountId, id)
      assertVisible(caller, row)
      const life = () => requireLife(ctx)
      const mutate = async (action: string, run: () => Promise<WorkspaceRow>) => {
        requireScope(caller, 'workspaces:write')
        if (caller.via === 'workspace' && row.id === caller.sandboxId) {
          // An agent must not put its own VM to sleep or delete it from under itself.
          throw new ApiError(403, 'forbidden', 'own_workspace')
        }
        const started = performance.now()
        const next = await run()
        await auditCaller(ctx.db, caller, { action: `workspace.${action}`, targetType: 'workspace', targetId: row.id, detail: { ms: Math.round(performance.now() - started) } }, ctx.now())
        return json({ workspace: workspaceView(next) })
      }
      if (!sub && method === 'GET') {
        requireScope(caller, 'workspaces:read')
        return json({ workspace: workspaceView(row) })
      }
      if (!sub && method === 'DELETE') {
        return mutate('destroy', () => destroyWorkspace(life(), row))
      }
      if (sub === 'sleep' && method === 'POST') {
        return mutate('sleep', () => sleepWorkspace(life(), row))
      }
      if (sub === 'wake' && method === 'POST') {
        return mutate('wake', () => wakeWorkspace(life(), row))
      }
      if (sub === 'archive' && method === 'POST') {
        return mutate('archive', () => archiveWorkspace(life(), row))
      }
      if (sub === 'sessions' && !subId && method === 'GET') {
        requireScope(caller, 'workspaces:read')
        if (row.status !== 'running' || !row.session_id) {
          return json({ workspaceStatus: workspaceView(row).status, sessions: [] })
        }
        return json({ workspaceStatus: 'running', sessions: await listSessions(life().provider, row.session_id) })
      }
      if (sub === 'sessions' && subId && method === 'GET') {
        requireScope(caller, 'workspaces:read')
        if (!/^term_[A-Za-z0-9-]{1,80}$/.test(subId)) {
          throw new ApiError(404, 'not_found')
        }
        if (row.status !== 'running' || !row.session_id) {
          throw new ApiError(409, 'conflict', 'workspace_not_running')
        }
        return json({ session: { handle: subId, ...(await readSession(life().provider, row.session_id, subId)) } })
      }
      if (sub === 'messages' && !subId && method === 'GET') {
        requireScope(caller, 'workspaces:read')
        return json({ messages: (await listMessages(ctx.db, row.id, 50)).map(messageView) })
      }
      if (sub === 'messages' && subId && method === 'GET') {
        requireScope(caller, 'workspaces:read')
        const message = await getMessage(ctx.db, subId)
        if (!message || message.sandbox_id !== row.id) {
          throw new ApiError(404, 'not_found')
        }
        return json({ message: messageView(message) })
      }
      if (sub === 'messages' && !subId && method === 'POST') {
        requireScope(caller, 'messages:write')
        const life = requireLife(ctx)
        await consumeRate(ctx.db, messageBucket(caller), MESSAGES_PER_MINUTE, now)
        const body = parse(MessageBody, await ctx.readJson())
        const queued = await queueMessage(ctx.db, { workspace: row, sentBy: caller.userId, agent: body.agent ?? 'claude', text: body.text, session: body.session }, now)
        await auditCaller(ctx.db, caller, { action: 'workspace.message', targetType: 'workspace', targetId: row.id, detail: { messageId: queued.id, chars: body.text.length, continues: Boolean(body.session) } }, now)
        // Queued now, delivered in the background (waking the VM if it sleeps); poll the message.
        ctx.waitUntil(deliverMessage(life, queued))
        return json({ message: messageView(queued) }, 202, { location: `/v1/workspaces/${row.id}/messages/${queued.id}` })
      }
    }
  }

  void actorOf
  throw new ApiError(404, 'not_found')
}
