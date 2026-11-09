// Team workspace registry: the cloud-owned list of an org's workspaces (who made it, who owns it,
// repo/branch, state, last activity, visibility, section, cost) and who is in each one right now.
//   GET   /v1/team/workspaces?scope=mine|team|all&by=<userId>&repo=<url>&section=<s>&archived=exclude|include|only
//   GET   /v1/team/workspaces/:id
//   PATCH /v1/team/workspaces/:id {title?, branch?, visibility?, section?, archived?, ownerUserId?, tokenUsdMicros?}
//   POST  /v1/team/workspaces/:id/presence {clientId, state: viewing|typing|left, chatId?}
//   GET   /v1/team/links/resolve?w=<sandboxId>&c=<chatId>
// Access rule: a workspace is visible to its owner, and to every member of the owning org when
// visibility is `team`. Org owners/admins additionally see private rows' metadata (scope=all) so a
// departed member's workspaces can be reassigned or archived — metadata only, never access.
import { z } from 'zod'
import type { SandboxCaller } from './auth'
import type { MachineSize } from './entitlements'
import { getSandbox, touchActivity, updateRegistry, type SandboxRow } from './store'
import { memberNamesFor } from './member-names'
import { sandboxView } from './wire'

export const PRESENCE_TTL_MS = 45_000
/** Billing's overage rate (75¢ per standard hour, large weighs 2) in USD micros per wall-clock hour. */
export const COMPUTE_USD_MICROS_PER_HOUR: Record<MachineSize, number> = { standard: 750_000, large: 1_500_000 }

export type WorkspaceAccess = 'owner' | 'granted' | 'can_open' | 'none'

export class WorkspaceError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'invalid_request' | 'conflict',
    readonly reason?: string
  ) {
    super(reason ? `${code}:${reason}` : code)
    this.name = 'WorkspaceError'
  }
}

export const WORKSPACE_ERROR_STATUS: Record<WorkspaceError['code'], number> = {
  not_found: 404,
  forbidden: 403,
  invalid_request: 400,
  conflict: 409
}

export function isOrgAdmin(caller: SandboxCaller): boolean {
  return caller.orgId !== undefined && (caller.orgRole === 'owner' || caller.orgRole === 'admin')
}

export function isOwner(caller: SandboxCaller, row: SandboxRow): boolean {
  return row.account_id === caller.accountId && row.user_id === caller.userId
}

/** Can the caller see this row at all (list, links, presence)? */
export function canSee(caller: SandboxCaller, row: SandboxRow): boolean {
  if (row.account_id !== caller.accountId || row.status === 'destroyed') {
    return false
  }
  return row.user_id === caller.userId || (row.visibility === 'team' && caller.orgId !== undefined)
}

/** Can the caller pair a device with it (grant) or keep it awake (lease)? */
export function canOpen(caller: SandboxCaller, row: SandboxRow): boolean {
  return canSee(caller, row) && row.archived_at === null
}

/** Rename, section, archive, visibility: the owner, or an org admin for anything in the org. */
function canManage(caller: SandboxCaller, row: SandboxRow): boolean {
  return row.account_id === caller.accountId && (row.user_id === caller.userId || isOrgAdmin(caller))
}

/** A row the caller may address by id; anything else is indistinguishable from a missing one. */
export async function requireVisible(db: D1Database, caller: SandboxCaller, id: string): Promise<SandboxRow> {
  const row = await getSandbox(db, id)
  if (!row || !(canSee(caller, row) || (row.account_id === caller.accountId && isOrgAdmin(caller) && row.status !== 'destroyed'))) {
    throw new WorkspaceError('not_found')
  }
  return row
}

type PresenceRow = { sandbox_id: string; user_id: string; client_id: string; state: 'viewing' | 'typing'; chat_id: string | null; updated_at: number }

async function presenceFor(db: D1Database, ids: readonly string[], now: number): Promise<Map<string, PresenceRow[]>> {
  const out = new Map<string, PresenceRow[]>()
  if (ids.length === 0) {
    return out
  }
  const { results } = await db
    .prepare(
      `SELECT * FROM workspace_presence WHERE updated_at > ? AND sandbox_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY updated_at DESC`
    )
    .bind(now - PRESENCE_TTL_MS, ...ids)
    .all<PresenceRow>()
  for (const row of results) {
    const list = out.get(row.sandbox_id) ?? []
    list.push(row)
    out.set(row.sandbox_id, list)
  }
  return out
}

async function computeMsFor(db: D1Database, ids: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (ids.length === 0) {
    return out
  }
  const { results } = await db
    .prepare(
      `SELECT sandbox_id, SUM(ended_at - started_at) AS ms FROM usage_outbox
       WHERE sandbox_id IN (${ids.map(() => '?').join(', ')}) GROUP BY sandbox_id`
    )
    .bind(...ids)
    .all<{ sandbox_id: string; ms: number }>()
  for (const row of results) {
    out.set(row.sandbox_id, Number(row.ms) || 0)
  }
  return out
}

async function activeGrantUsers(db: D1Database, ids: readonly string[], userId: string): Promise<Set<string>> {
  if (ids.length === 0) {
    return new Set()
  }
  const { results } = await db
    .prepare(
      `SELECT DISTINCT sandbox_id FROM workspace_grants WHERE user_id = ? AND status = 'active'
       AND sandbox_id IN (${ids.map(() => '?').join(', ')})`
    )
    .bind(userId, ...ids)
    .all<{ sandbox_id: string }>()
  return new Set(results.map((r) => r.sandbox_id))
}

function accessFor(caller: SandboxCaller, row: SandboxRow, granted: boolean): WorkspaceAccess {
  if (isOwner(caller, row)) {
    return 'owner'
  }
  if (!canSee(caller, row)) {
    return 'none'
  }
  return granted ? 'granted' : row.archived_at === null ? 'can_open' : 'none'
}

/** Cost so far: finished segments plus the open session up to now, at billing's hourly rate. */
export function costView(row: SandboxRow, settledMs: number, now: number) {
  const liveMs = row.status === 'running' && row.usage_settled_at !== null ? Math.max(0, now - row.usage_settled_at) : 0
  const computeMs = settledMs + liveMs
  const rate = COMPUTE_USD_MICROS_PER_HOUR[row.machine_size] ?? COMPUTE_USD_MICROS_PER_HOUR.standard
  const computeUsdMicros = Math.round((computeMs / 3_600_000) * rate)
  return {
    computeMs,
    rateUsdMicrosPerHour: rate,
    computeUsdMicros,
    tokenUsdMicros: row.token_usd_micros,
    totalUsdMicros: computeUsdMicros + (row.token_usd_micros ?? 0)
  }
}

function repoView(row: SandboxRow) {
  return row.repo_url ? { url: row.repo_url, branch: row.repo_branch } : null
}

export async function workspaceViews(db: D1Database, caller: SandboxCaller, rows: readonly SandboxRow[], now: number) {
  const ids = rows.map((r) => r.id)
  const [presence, compute, granted] = await Promise.all([
    presenceFor(db, ids, now),
    computeMsFor(db, ids),
    activeGrantUsers(db, ids, caller.userId)
  ])
  const referenced = (row: SandboxRow, live: readonly PresenceRow[]) =>
    [row.user_id, row.created_by, row.last_activity_by, ...live.map((p) => p.user_id)].filter(
      (id): id is string => typeof id === 'string'
    )
  const names = await memberNamesFor(
    db,
    caller.accountId,
    rows.flatMap((row) => referenced(row, presence.get(row.id) ?? []))
  )
  return rows.map((row) => {
    const access = accessFor(caller, row, granted.has(row.id))
    // Private rows an admin sees for management show who/what, never live presence.
    const showPresence = access !== 'none'
    const live = showPresence ? (presence.get(row.id) ?? []) : []
    const memberNames = Object.fromEntries(
      referenced(row, live).flatMap((id) => (names.has(id) ? [[id, names.get(id)!]] : []))
    )
    return {
      ...sandboxView(row),
      title: row.name,
      repo: repoView(row),
      visibility: row.visibility,
      section: row.section,
      archivedAt: row.archived_at,
      createdBy: row.created_by ?? row.user_id,
      ownerUserId: row.user_id,
      lastActivityAt: row.last_activity_at ?? row.updated_at,
      lastActivityBy: row.last_activity_by,
      cost: costView(row, compute.get(row.id) ?? 0, now),
      access,
      presence: live.map((p) => ({ userId: p.user_id, clientId: p.client_id, state: p.state, chatId: p.chat_id, at: p.updated_at })),
      // Display names (token `name` claim) for the ids above; the roster wins where it has one.
      memberNames
    }
  })
}

const ListQuery = z.object({
  scope: z.enum(['mine', 'team', 'all']).default('team'),
  by: z.string().min(1).max(128).optional(),
  repo: z.string().min(1).max(2048).optional(),
  section: z.string().min(1).max(64).optional(),
  archived: z.enum(['exclude', 'include', 'only']).default('exclude')
})

export async function listWorkspaces(db: D1Database, caller: SandboxCaller, url: URL, now: number) {
  const query = ListQuery.safeParse(Object.fromEntries(url.searchParams))
  if (!query.success) {
    throw new WorkspaceError('invalid_request')
  }
  const q = query.data
  if (q.scope === 'all' && !isOrgAdmin(caller)) {
    throw new WorkspaceError('forbidden', 'admin_only')
  }
  const { results } = await db
    .prepare(`SELECT * FROM sandboxes WHERE account_id = ? AND status <> 'destroyed' ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT 500`)
    .bind(caller.accountId)
    .all<SandboxRow>()
  const rows = results.filter((row) => {
    if (q.scope === 'mine' ? row.user_id !== caller.userId : q.scope === 'team' ? !canSee(caller, row) : false) {
      return false
    }
    if (q.by && row.user_id !== q.by && row.created_by !== q.by) {
      return false
    }
    if (q.repo && row.repo_url !== q.repo) {
      return false
    }
    if (row.hidden) {
      return false
    }
    if (q.section && row.section !== q.section) {
      return false
    }
    return q.archived === 'include' || (q.archived === 'only') === (row.archived_at !== null)
  })
  return { workspaces: await workspaceViews(db, caller, rows, now) }
}

const SECTION = z.string().trim().min(1).max(64).regex(/^[^\u0000-\u001f]+$/)
export const PatchSchema = z
  .object({
    title: z.string().trim().min(1).max(120).regex(/^[^\u0000-\u001f]+$/).nullable().optional(),
    branch: z.string().min(1).max(255).regex(/^[^\s~^:?*[\\\u0000-\u001f]+$/).nullable().optional(),
    visibility: z.enum(['private', 'team']).optional(),
    section: SECTION.nullable().optional(),
    archived: z.boolean().optional(),
    ownerUserId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional(),
    /** Model spend reported by the workspace's agents (cumulative, USD micros). Owner/grantee only. */
    tokenUsdMicros: z.number().int().min(0).max(1e12).optional()
  })
  .strict()

export type WorkspacePatch = z.infer<typeof PatchSchema>

/**
 * Applies a registry edit. Returns what access changed so the caller can revoke grants:
 * going private or changing owner revokes every member device the old rules let in.
 */
export async function patchWorkspace(
  db: D1Database,
  caller: SandboxCaller,
  row: SandboxRow,
  patch: WorkspacePatch,
  now: number
): Promise<{ row: SandboxRow; revoke: 'none' | 'non_owner' | 'all_but_new_owner' }> {
  const metadataOnly = patch.tokenUsdMicros !== undefined && Object.keys(patch).length === 1
  if (metadataOnly) {
    if (!canOpen(caller, row)) {
      throw new WorkspaceError('not_found')
    }
  } else if (!canManage(caller, row)) {
    throw new WorkspaceError(canSee(caller, row) ? 'forbidden' : 'not_found', 'owner_or_admin_only')
  }
  if (patch.visibility === 'team' && !row.account_id.includes('org:')) {
    // A personal account has no team to share with.
    throw new WorkspaceError('invalid_request', 'personal_account')
  }
  if (patch.ownerUserId !== undefined && patch.ownerUserId !== row.user_id) {
    // Membership is proven by the new owner's own token later; here the caller must be allowed to hand it over.
    if (!isOrgAdmin(caller) && row.user_id !== caller.userId) {
      throw new WorkspaceError('forbidden', 'owner_or_admin_only')
    }
    if (!row.account_id.includes('org:')) {
      throw new WorkspaceError('invalid_request', 'personal_account')
    }
  }
  const next = await updateRegistry(db, row.id, {
    ...(patch.title !== undefined ? { name: patch.title } : {}),
    ...(patch.branch !== undefined ? { repo_branch: patch.branch } : {}),
    ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
    ...(patch.section !== undefined ? { section: patch.section } : {}),
    ...(patch.archived !== undefined ? { archived_at: patch.archived ? (row.archived_at ?? now) : null } : {}),
    ...(patch.ownerUserId !== undefined ? { user_id: patch.ownerUserId } : {}),
    ...(patch.tokenUsdMicros !== undefined ? { token_usd_micros: patch.tokenUsdMicros } : {})
  })
  if (!next) {
    throw new WorkspaceError('not_found')
  }
  const ownerChanged = patch.ownerUserId !== undefined && patch.ownerUserId !== row.user_id
  const wentPrivate = row.visibility === 'team' && next.visibility === 'private'
  const archived = patch.archived === true && row.archived_at === null
  return { row: next, revoke: ownerChanged ? 'all_but_new_owner' : wentPrivate || archived ? 'non_owner' : 'none' }
}

export const PresenceSchema = z
  .object({
    clientId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
    state: z.enum(['viewing', 'typing', 'left']),
    chatId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).nullable().optional()
  })
  .strict()

export async function reportPresence(
  db: D1Database,
  caller: SandboxCaller,
  row: SandboxRow,
  body: z.infer<typeof PresenceSchema>,
  now: number
) {
  if (!canSee(caller, row)) {
    throw new WorkspaceError('not_found')
  }
  if (body.state === 'left') {
    await db
      .prepare('DELETE FROM workspace_presence WHERE sandbox_id = ? AND user_id = ? AND client_id = ?')
      .bind(row.id, caller.userId, body.clientId)
      .run()
  } else {
    await db.batch([
      db
        .prepare(
          `INSERT INTO workspace_presence (sandbox_id, user_id, client_id, state, chat_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (sandbox_id, user_id, client_id) DO UPDATE SET state = excluded.state, chat_id = excluded.chat_id, updated_at = excluded.updated_at`
        )
        .bind(row.id, caller.userId, body.clientId, body.state, body.chatId ?? null, now),
      // Keep the table small: stale rows are noise for every reader.
      db.prepare('DELETE FROM workspace_presence WHERE sandbox_id = ? AND updated_at < ?').bind(row.id, now - 10 * PRESENCE_TTL_MS)
    ])
    await touchActivity(db, row.id, caller.userId, now)
  }
  const [view] = await workspaceViews(db, caller, [row], now)
  return { presence: view!.presence }
}

const LinkQuery = z.object({
  w: z.string().regex(/^sbx_[0-9a-f]{24}$/),
  c: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/).optional()
})

/** orca://cloud/w/<id>[/c/<chat>] → the workspace if the caller can see it; otherwise not_found. */
export async function resolveLink(db: D1Database, caller: SandboxCaller, url: URL, now: number) {
  const query = LinkQuery.safeParse(Object.fromEntries(url.searchParams))
  if (!query.success) {
    throw new WorkspaceError('invalid_request')
  }
  const row = await getSandbox(db, query.data.w)
  if (!row || !canSee(caller, row)) {
    // Private, other org, or gone: the link reveals nothing about which.
    throw new WorkspaceError('not_found')
  }
  const [view] = await workspaceViews(db, caller, [row], now)
  return { workspace: view, chatId: query.data.c ?? null }
}

/** Canonical deep link for a workspace (and optionally a chat in it). */
export function workspaceLink(id: string, chatId?: string): string {
  return `orca://cloud/w/${id}${chatId ? `/c/${encodeURIComponent(chatId)}` : ''}`
}
