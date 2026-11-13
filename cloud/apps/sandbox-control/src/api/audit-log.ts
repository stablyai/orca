// The team audit log: every recorded change in one feed, for owners and admins of a team whose
// plan includes it (billing's `audit_log` entitlement, Enterprise).
//
//   GET /v1/audit-log?category=&actor=&cursor=&limit=          -> {events, nextCursor, actors}
//   GET /v1/audit-log?format=csv[&category=&actor=]            -> text/csv, newest first
//
// Sources, merged newest first in one query:
//   audit_log      API keys, workspaces, settings, projects, routines, connected apps, members
//   secret_events  cloud secret creates, updates and deletes (names only)
// Recording happens for every team on every plan, so a team that upgrades sees its history. Only
// reading is gated: scope audit:read, then the owner or admin role, then the plan.
// An event never carries a secret value or hint: secret_events has no such column, and detail
// fields whose name suggests a credential are dropped on the way out.
import { memberNamesFor } from '../member-names'
import { ApiError, requireAdmin, requireScope, type ApiCaller } from './caller'
import type { ApiContext } from './router'

export const AUDIT_CATEGORIES = ['members', 'security', 'api_keys', 'apps', 'workspaces', 'secrets', 'routines', 'settings', 'billing', 'other'] as const
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number]

/** Action prefix -> category. The first match wins; anything unmatched is `other`. */
const CATEGORY_PREFIXES: ReadonlyArray<readonly [string, AuditCategory]> = [
  ['member.', 'members'],
  ['team.', 'members'],
  ['mfa.', 'security'],
  ['sso.', 'security'],
  ['scim.', 'security'],
  ['api_key.', 'api_keys'],
  ['workspace_token.', 'api_keys'],
  ['mcp.', 'apps'],
  ['workspace.', 'workspaces'],
  ['sandbox.', 'workspaces'],
  ['secret.', 'secrets'],
  ['routine.', 'routines'],
  ['settings.', 'settings'],
  ['project.', 'settings'],
  ['billing.', 'billing']
]

export function categoryOf(action: string): AuditCategory {
  return CATEGORY_PREFIXES.find(([prefix]) => action.startsWith(prefix))?.[1] ?? 'other'
}

export const DEFAULT_AUDIT_PAGE = 50
export const MAX_AUDIT_PAGE = 200
/** One export is at most this many events (newest first); filter by category or actor for more. */
export const MAX_EXPORT_ROWS = 5000

type MergedRow = {
  id: string
  created_at: number
  actor_type: string
  actor_id: string
  user_id: string | null
  action: string
  target_type: string | null
  target_id: string | null
  detail: string | null
  actor_name: string | null
}

export type AuditActor = {
  /** `former_member`: auth told us they left the team. `system`: Orca did it (a sync, a cleanup). */
  kind: 'person' | 'former_member' | 'system'
  userId: string | null
  name: string | null
  /** How the person acted, when not directly in the app. */
  via: 'api_key' | 'mcp' | 'agent' | 'routine' | null
}

export type AuditEvent = {
  id: string
  at: number
  category: AuditCategory
  action: string
  actor: AuditActor
  target: { type: string; id: string | null; label: string | null } | null
  detail: Record<string, unknown> | null
}

// Both sources as one relation with audit_log's columns. A secret's target id is its NAME (the
// variable name is what admins search for; it is not the value).
const MERGED = `
  SELECT id, created_at, actor_type, actor_id, user_id, action, target_type, target_id, detail, NULL AS actor_name
    FROM audit_log WHERE account_id = ?1
  UNION ALL
  SELECT id, created_at, 'user', actor_user_id, actor_user_id, 'secret.' || action, 'secret', name,
         json_object('scope', scope, 'repo', CASE WHEN scope = 'repo' THEN substr(owner_id, instr(owner_id, '#') + 1) END),
         actor_name
    FROM secret_events WHERE account_id = ?1`

/** Opaque cursor: `<created_at>.<id>` of the last event on the page. */
function parseCursor(cursor: string | null): { at: number; id: string } | null {
  const match = /^(\d{1,16})\.([A-Za-z0-9_-]{1,80})$/.exec(cursor ?? '')
  return match ? { at: Number(match[1]), id: match[2]! } : null
}

export type AuditQuery = {
  category: AuditCategory | null
  /** A user id, or `system`. */
  actor: string | null
  cursor: string | null
  limit: number
}

function whereFor(query: AuditQuery): { sql: string; binds: Array<string | number> } {
  const clauses: string[] = []
  const binds: Array<string | number> = []
  const after = parseCursor(query.cursor)
  if (after) {
    clauses.push('(created_at < ? OR (created_at = ? AND id < ?))')
    binds.push(after.at, after.at, after.id)
  }
  if (query.category === 'other') {
    for (const [prefix] of CATEGORY_PREFIXES) {
      clauses.push('substr(action, 1, ?) <> ?')
      binds.push(prefix.length, prefix)
    }
  } else if (query.category) {
    const prefixes = CATEGORY_PREFIXES.filter(([, category]) => category === query.category)
    clauses.push(`(${prefixes.map(() => 'substr(action, 1, ?) = ?').join(' OR ')})`)
    for (const [prefix] of prefixes) {
      binds.push(prefix.length, prefix)
    }
  }
  if (query.actor === 'system') {
    clauses.push("actor_type = 'system'")
  } else if (query.actor) {
    // A system row's user_id is who it happened TO (the member removed), not who did it.
    clauses.push("actor_type <> 'system' AND user_id = ?")
    binds.push(query.actor)
  }
  return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', binds }
}

const SENSITIVE_DETAIL_KEY = /secret|token|password|passphrase|hint|value|ciphertext|credential|private/i

/** Detail as recorded, minus any field that could hold a credential (defence in depth), nulls dropped. */
function safeDetail(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null && !SENSITIVE_DETAIL_KEY.test(key)) {
      out[key] = value
    }
  }
  return Object.keys(out).length ? out : null
}

const VIA: Record<string, AuditActor['via']> = { api_key: 'api_key', mcp: 'mcp', workspace_token: 'agent', routine: 'routine' }

type Labels = { names: ReadonlyMap<string, string>; former: ReadonlySet<string>; workspaces: ReadonlyMap<string, string> }

/** The new owner of a workspace, for `workspace.owner_changed` rows. */
function newOwnerId(detail: Record<string, unknown> | null): string | null {
  return typeof detail?.toUserId === 'string' ? detail.toUserId : null
}

function eventView(row: MergedRow, labels: Labels): AuditEvent {
  let detail = safeDetail(row.detail)
  if (row.action === 'workspace.owner_changed') {
    // Named as of now, like every other person in the log: a new owner who has since left reads
    // as a former member, and one nobody can name is left as an id for the caller to word.
    const owner = newOwnerId(detail)
    const name = owner ? labels.names.get(owner) : undefined
    if (owner && detail) {
      detail = { ...detail, ...(name ? { toUserName: name } : {}), ...(labels.former.has(owner) ? { toUserFormer: true } : {}) }
    }
  }
  const system = row.actor_type === 'system'
  const actorId = system ? null : row.user_id
  const actor: AuditActor = system
    ? { kind: 'system', userId: null, name: null, via: null }
    : {
        kind: actorId && labels.former.has(actorId) ? 'former_member' : 'person',
        userId: actorId,
        name: (actorId ? labels.names.get(actorId) : undefined) ?? row.actor_name ?? null,
        via: VIA[row.actor_type] ?? null
      }
  let target: AuditEvent['target'] = null
  if (row.target_type) {
    const recorded = typeof detail?.name === 'string' ? detail.name : null
    const label =
      row.target_type === 'workspace' || row.target_type === 'sandbox'
        ? ((row.target_id ? labels.workspaces.get(row.target_id) : undefined) ?? recorded)
        : row.target_type === 'member'
          ? ((row.target_id ? labels.names.get(row.target_id) : undefined) ?? null)
          : row.target_type === 'secret'
            ? row.target_id
            : recorded
    target = { type: row.target_type, id: row.target_id, label: label ?? null }
  } else if (system && row.user_id && row.action.startsWith('member.')) {
    // Auth's pushes record the member in user_id: they are who it happened to.
    target = { type: 'member', id: row.user_id, label: labels.names.get(row.user_id) ?? null }
  }
  return { id: row.id, at: row.created_at, category: categoryOf(row.action), action: row.action, actor, target, detail }
}

async function inChunks<T>(ids: readonly string[], run: (chunk: string[], marks: string) => Promise<T[]>): Promise<T[]> {
  const out: T[] = []
  // D1 caps bound parameters per statement; chunk well under it.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    out.push(...(await run(chunk, chunk.map(() => '?').join(', '))))
  }
  return out
}

async function labelsFor(db: D1Database, accountId: string, rows: readonly MergedRow[]): Promise<Labels> {
  const people = new Set<string>()
  const workspaceIds = new Set<string>()
  for (const row of rows) {
    if (row.user_id) {
      people.add(row.user_id)
    }
    if (row.target_id && row.target_type === 'member') {
      people.add(row.target_id)
    }
    if (row.target_id && (row.target_type === 'workspace' || row.target_type === 'sandbox')) {
      workspaceIds.add(row.target_id)
    }
    if (row.action === 'workspace.owner_changed') {
      const owner = newOwnerId(safeDetail(row.detail))
      if (owner) {
        people.add(owner)
      }
    }
  }
  const ids = [...people]
  const [names, left, workspaces] = await Promise.all([
    memberNamesFor(db, accountId, ids),
    inChunks(ids, async (chunk, marks) =>
      (
        await db
          .prepare(`SELECT user_id FROM member_changes WHERE account_id = ? AND removed_at IS NOT NULL AND user_id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<{ user_id: string }>()
      ).results
    ),
    inChunks([...workspaceIds], async (chunk, marks) =>
      (
        await db
          .prepare(`SELECT id, name FROM sandboxes WHERE account_id = ? AND name IS NOT NULL AND id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<{ id: string; name: string }>()
      ).results
    )
  ])
  return {
    names,
    former: new Set(left.map((row) => row.user_id)),
    workspaces: new Map(workspaces.map((row) => [row.id, row.name]))
  }
}

/** One page of the merged log for an account, newest first. No access checks: callers gate. */
export async function listAuditEvents(
  db: D1Database,
  accountId: string,
  query: AuditQuery
): Promise<{ events: AuditEvent[]; nextCursor: string | null }> {
  const where = whereFor(query)
  const { results } = await db
    .prepare(`SELECT * FROM (${MERGED}) ${where.sql} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(accountId, ...where.binds, query.limit + 1)
    .all<MergedRow>()
  const page = results.slice(0, query.limit)
  const labels = await labelsFor(db, accountId, page)
  const last = page.at(-1)
  return {
    events: page.map((row) => eventView(row, labels)),
    nextCursor: results.length > query.limit && last ? `${last.created_at}.${last.id}` : null
  }
}

/** Everyone who appears as an actor in the account's log (for the "by person" filter), capped. */
export async function listAuditActors(db: D1Database, accountId: string): Promise<AuditActor[]> {
  const { results } = await db
    .prepare(`SELECT user_id, MAX(actor_name) AS actor_name FROM (${MERGED}) WHERE actor_type <> 'system' AND user_id IS NOT NULL GROUP BY user_id LIMIT 200`)
    .bind(accountId)
    .all<{ user_id: string; actor_name: string | null }>()
  const ids = results.map((row) => row.user_id)
  const [names, left] = await Promise.all([
    memberNamesFor(db, accountId, ids),
    inChunks(ids, async (chunk, marks) =>
      (
        await db
          .prepare(`SELECT user_id FROM member_changes WHERE account_id = ? AND removed_at IS NOT NULL AND user_id IN (${marks})`)
          .bind(accountId, ...chunk)
          .all<{ user_id: string }>()
      ).results
    )
  ])
  const former = new Set(left.map((row) => row.user_id))
  return results
    .map((row): AuditActor => ({
      kind: former.has(row.user_id) ? 'former_member' : 'person',
      userId: row.user_id,
      name: names.get(row.user_id) ?? row.actor_name ?? null,
      via: null
    }))
    .sort((a, b) => (a.name ?? '￿').localeCompare(b.name ?? '￿'))
}

/** Spreadsheets run a cell that starts with = + - @ as a formula: such text is quoted as text. */
function csvCell(value: string | number | null): string {
  if (value === null) {
    return ''
  }
  let text = String(value)
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`
  }
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export const CSV_HEADER = ['time', 'category', 'action', 'actor_kind', 'actor_name', 'actor_user_id', 'via', 'target_type', 'target_id', 'target_label', 'detail']

export function auditCsv(events: readonly AuditEvent[]): string {
  const lines = [CSV_HEADER.join(',')]
  for (const event of events) {
    lines.push(
      [
        new Date(event.at).toISOString(),
        event.category,
        event.action,
        event.actor.kind,
        event.actor.name,
        event.actor.userId,
        event.actor.via,
        event.target?.type ?? null,
        event.target?.id ?? null,
        event.target?.label ?? null,
        event.detail ? JSON.stringify(event.detail) : null
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return `${lines.join('\r\n')}\r\n`
}

function parseQuery(url: URL): AuditQuery {
  const category = url.searchParams.get('category')
  if (category !== null && !(AUDIT_CATEGORIES as readonly string[]).includes(category)) {
    throw new ApiError(400, 'invalid_request', 'category')
  }
  const actor = url.searchParams.get('actor')
  if (actor !== null && !/^[A-Za-z0-9_.:-]{1,128}$/.test(actor)) {
    throw new ApiError(400, 'invalid_request', 'actor')
  }
  const cursor = url.searchParams.get('cursor')
  if (cursor !== null && !parseCursor(cursor)) {
    throw new ApiError(400, 'invalid_request', 'cursor')
  }
  const raw = url.searchParams.get('limit')
  const parsed = raw === null ? DEFAULT_AUDIT_PAGE : Number(raw)
  const limit = Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, MAX_AUDIT_PAGE) : DEFAULT_AUDIT_PAGE
  return { category: category as AuditCategory | null, actor, cursor, limit }
}

/**
 * Who may read: a team's owner or admin (a signed-in desktop, or an API key with audit:read that
 * such a person made), and only while the team's plan includes the audit log. The role is checked
 * before the plan, so a member learns nothing about the team's plan from this route.
 */
export async function requireAuditLogAccess(caller: ApiCaller, ctx: Pick<ApiContext, 'features'>): Promise<void> {
  requireScope(caller, 'audit:read')
  if (!caller.orgId) {
    throw new ApiError(403, 'forbidden', 'team_required')
  }
  requireAdmin(caller)
  await requireAuditLogPlan(caller, ctx)
}

/**
 * The plan half of the gate, shared with the older GET /v1/audit so a team can't read the same
 * rows around it. Billing down or unconfigured throws BillingUnavailableError (503): never read
 * as "not on the plan", and never as an open log.
 */
export async function requireAuditLogPlan(caller: Pick<ApiCaller, 'accountId'>, ctx: Pick<ApiContext, 'features'>): Promise<void> {
  const features = ctx.features ? await ctx.features(caller.accountId) : { auditLog: false }
  if (!features.auditLog) {
    throw new ApiError(403, 'entitlement_denied', 'audit_log')
  }
}

export async function handleAuditLog(url: URL, caller: ApiCaller, ctx: ApiContext): Promise<Response> {
  await requireAuditLogAccess(caller, ctx)
  const query = parseQuery(url)
  const format = url.searchParams.get('format')
  if (format === 'csv') {
    const events: AuditEvent[] = []
    let cursor = query.cursor
    while (events.length < MAX_EXPORT_ROWS) {
      const page = await listAuditEvents(ctx.db, caller.accountId, { ...query, cursor, limit: Math.min(1000, MAX_EXPORT_ROWS - events.length) })
      events.push(...page.events)
      cursor = page.nextCursor
      if (!cursor) {
        break
      }
    }
    return new Response(auditCsv(events), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="orca-audit-log.csv"',
        'cache-control': 'no-store',
        // More rows exist past this file: the client says so instead of implying it is complete.
        'x-orca-audit-truncated': cursor ? 'true' : 'false'
      }
    })
  }
  if (format !== null && format !== 'json') {
    throw new ApiError(400, 'invalid_request', 'format')
  }
  const page = await listAuditEvents(ctx.db, caller.accountId, query)
  // The people filter's options only need loading with the first page.
  const actors = query.cursor ? undefined : await listAuditActors(ctx.db, caller.accountId)
  return Response.json({ ...page, ...(actors ? { actors } : {}), categories: AUDIT_CATEGORIES }, { headers: { 'cache-control': 'no-store' } })
}
