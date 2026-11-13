// SEC-4: customer-visible activity for cloud secrets (migration 0054_secret_events.sql).
//   GET /v1/secrets/activity?view=team|personal[&cursor=…][&limit=…]  -> {events, nextCursor}
// Each create, update and delete is recorded in the same D1 transaction as the write, so a change
// never lands without its record. A record holds who, when, the scope and the variable NAME. It never
// holds the value, the last-4 hint, ciphertext or any key material.
// Team activity (Shared and the team's Repository secrets) is for team owners and admins. Personal
// activity (and a personal account's Repository secrets) is for that user alone.
import { randomId } from './api/keys'
import type { SandboxCaller } from './auth'
import type { SecretScope } from './secrets'

export type SecretEventAction = 'created' | 'updated' | 'deleted'

/** Who made a change, from the verified desktop token. */
export type SecretActor = { userId: string; name?: string; orgId?: string }

export const ACTIVITY_WINDOW_MS = 90 * 24 * 60 * 60_000
export const DEFAULT_ACTIVITY_PAGE = 50
export const MAX_ACTIVITY_PAGE = 100

export function actorOf(caller: SandboxCaller): SecretActor {
  return {
    userId: caller.userId,
    ...(caller.name ? { name: caller.name } : {}),
    ...(caller.orgId ? { orgId: caller.orgId } : {})
  }
}

/**
 * Whose log a change belongs to. Personal secrets go to the user (`user:<id>`), never to the team the
 * token happened to be for; Shared and Repository secrets go to the account that owns them.
 */
export function eventAccountFor(scope: SecretScope, ownerId: string): string {
  if (scope === 'repo') {
    return ownerId.slice(0, ownerId.indexOf('#'))
  }
  return ownerId
}

const EXISTS = 'EXISTS (SELECT 1 FROM secrets WHERE scope = ? AND owner_id = ? AND name = ?)'

/**
 * The record for a write, to batch BEFORE the upsert: 'updated' when the row already exists, else
 * 'created'. Runs in the write's transaction, so it can't disagree with what the upsert did.
 */
export function writeEventStatement(
  db: D1Database,
  target: { scope: SecretScope; ownerId: string; name: string },
  actor: SecretActor,
  now: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO secret_events (id, account_id, scope, owner_id, name, action, actor_user_id, actor_name, actor_org_id, created_at)
       VALUES (?, ?, ?, ?, ?, CASE WHEN ${EXISTS} THEN 'updated' ELSE 'created' END, ?, ?, ?, ?)`
    )
    .bind(
      randomId('sev'),
      eventAccountFor(target.scope, target.ownerId),
      target.scope,
      target.ownerId,
      target.name,
      target.scope,
      target.ownerId,
      target.name,
      actor.userId,
      actor.name ?? null,
      actor.orgId ?? null,
      now
    )
}

/** The record for a delete, to batch BEFORE the DELETE: inserts nothing when there is no such row. */
export function deleteEventStatement(
  db: D1Database,
  target: { scope: SecretScope; ownerId: string; name: string },
  actor: SecretActor,
  now: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO secret_events (id, account_id, scope, owner_id, name, action, actor_user_id, actor_name, actor_org_id, created_at)
       SELECT ?, ?, scope, owner_id, name, 'deleted', ?, ?, ?, ? FROM secrets WHERE scope = ? AND owner_id = ? AND name = ?`
    )
    .bind(
      randomId('sev'),
      eventAccountFor(target.scope, target.ownerId),
      actor.userId,
      actor.name ?? null,
      actor.orgId ?? null,
      now,
      target.scope,
      target.ownerId,
      target.name
    )
}

type EventRow = {
  id: string
  scope: SecretScope
  owner_id: string
  name: string
  action: SecretEventAction
  actor_user_id: string
  actor_name: string | null
  actor_org_id: string | null
  created_at: number
}

export type SecretEventView = {
  id: string
  action: SecretEventAction
  scope: SecretScope
  name: string
  repo?: string
  actor: { userId: string; name: string | null }
  orgId: string | null
  at: number
}

function eventView(row: EventRow): SecretEventView {
  return {
    id: row.id,
    action: row.action,
    scope: row.scope,
    name: row.name,
    ...(row.scope === 'repo' ? { repo: row.owner_id.slice(row.owner_id.indexOf('#') + 1) } : {}),
    actor: { userId: row.actor_user_id, name: row.actor_name },
    orgId: row.actor_org_id,
    at: row.created_at
  }
}

/** Opaque cursor: `<created_at>.<id>` of the last event on the page. */
function parseCursor(cursor: string | null): { at: number; id: string } | null {
  const match = /^(\d{1,16})\.(sev_[A-Za-z0-9_-]{1,64})$/.exec(cursor ?? '')
  return match ? { at: Number(match[1]), id: match[2]! } : null
}

export async function listSecretEvents(
  db: D1Database,
  accounts: readonly string[],
  options: { now: number; cursor: string | null; limit: number }
): Promise<{ events: SecretEventView[]; nextCursor: string | null }> {
  const since = options.now - ACTIVITY_WINDOW_MS
  const after = parseCursor(options.cursor)
  const marks = accounts.map(() => '?').join(', ')
  const { results } = await db
    .prepare(
      `SELECT id, scope, owner_id, name, action, actor_user_id, actor_name, actor_org_id, created_at FROM secret_events
       WHERE account_id IN (${marks}) AND created_at >= ?
         AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?))
       ORDER BY created_at DESC, id DESC LIMIT ?`
    )
    .bind(...accounts, since, after ? 1 : null, after?.at ?? 0, after?.at ?? 0, after?.id ?? '', options.limit + 1)
    .all<EventRow>()
  const page = results.slice(0, options.limit)
  const last = page.at(-1)
  return {
    events: page.map(eventView),
    nextCursor: results.length > options.limit && last ? `${last.created_at}.${last.id}` : null
  }
}

export type ActivityView = 'team' | 'personal'

/** The accounts a caller may read for `view`, or a reason they may not. */
export function activityAccounts(
  caller: SandboxCaller,
  view: ActivityView,
  personalOwnerId: string
): { accounts: string[] } | { error: 'no_org' | 'org_admin_required' } {
  if (view === 'team') {
    if (!caller.orgId) {
      return { error: 'no_org' }
    }
    if (caller.orgRole !== 'owner' && caller.orgRole !== 'admin') {
      return { error: 'org_admin_required' }
    }
    return { accounts: [caller.accountId] }
  }
  // A personal account's Repository secrets are its own; a team token's are the team's.
  return { accounts: caller.orgId || caller.accountId === personalOwnerId ? [personalOwnerId] : [personalOwnerId, caller.accountId] }
}

export function activityLimit(raw: string | null): number {
  const parsed = raw === null ? DEFAULT_ACTIVITY_PAGE : Number(raw)
  return Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, MAX_ACTIVITY_PAGE) : DEFAULT_ACTIVITY_PAGE
}
