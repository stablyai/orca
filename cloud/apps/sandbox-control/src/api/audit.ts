// Append-only audit log and per-caller rate limits for the public API.
import { ApiError, actorOf, type ApiCaller } from './caller'
import { randomId } from './keys'

export type AuditEntry = {
  action: string
  targetType?: string
  targetId?: string
  /** Small, secret-free JSON (names, ids, counts). */
  detail?: Record<string, unknown>
}

const MAX_DETAIL_BYTES = 2048

export async function audit(
  db: D1Database,
  actor: { accountId: string; type: string; id: string; userId?: string | null },
  entry: AuditEntry,
  now: number
): Promise<void> {
  let detail = entry.detail ? JSON.stringify(entry.detail) : null
  if (detail && detail.length > MAX_DETAIL_BYTES) {
    detail = JSON.stringify({ truncated: true })
  }
  await db
    .prepare(
      `INSERT INTO audit_log (id, account_id, actor_type, actor_id, user_id, action, target_type, target_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(randomId('aud'), actor.accountId, actor.type, actor.id, actor.userId ?? null, entry.action,
      entry.targetType ?? null, entry.targetId ?? null, detail, now)
    .run()
}

export function auditCaller(db: D1Database, caller: ApiCaller, entry: AuditEntry, now: number): Promise<void> {
  const actor = actorOf(caller)
  return audit(db, { accountId: caller.accountId, type: actor.type, id: actor.id, userId: caller.userId }, entry, now)
}

export type AuditRow = {
  id: string
  actor_type: string
  actor_id: string
  user_id: string | null
  action: string
  target_type: string | null
  target_id: string | null
  detail: string | null
  created_at: number
}

export async function listAudit(
  db: D1Database,
  accountId: string,
  options: { before?: number; limit: number }
): Promise<AuditRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, actor_type, actor_id, user_id, action, target_type, target_id, detail, created_at FROM audit_log
       WHERE account_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?`
    )
    .bind(accountId, options.before ?? Number.MAX_SAFE_INTEGER, options.limit)
    .all<AuditRow>()
  return results
}

export function auditView(row: AuditRow, names: ReadonlyMap<string, string> = new Map()) {
  let detail: unknown = null
  try {
    detail = row.detail ? JSON.parse(row.detail) : null
  } catch {
    detail = null
  }
  return {
    id: row.id,
    actor: { type: row.actor_type, id: row.actor_id, userId: row.user_id, userName: row.user_id ? (names.get(row.user_id) ?? null) : null },
    action: row.action,
    target: row.target_type ? { type: row.target_type, id: row.target_id } : null,
    detail,
    createdAt: row.created_at
  }
}

export type RateLimit = { limit: number; remaining: number; resetAt: number }

/**
 * Fixed one-minute window per (bucket); D1 upsert so every isolate shares the count. Reads are
 * cheap but still counted: a runaway script hits the wall before it hits Vercel.
 */
export async function consumeRate(db: D1Database, bucket: string, limit: number, now: number): Promise<RateLimit> {
  const windowStart = now - (now % 60_000)
  const row = await db
    .prepare(
      `INSERT INTO rate_windows (bucket, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (bucket) DO UPDATE SET
         count = CASE WHEN rate_windows.window_start = excluded.window_start THEN rate_windows.count + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING count`
    )
    .bind(bucket, windowStart)
    .first<{ count: number }>()
  const count = row?.count ?? 1
  const rate = { limit, remaining: Math.max(0, limit - count), resetAt: windowStart + 60_000 }
  if (count > limit) {
    throw new RateLimitedError(rate, Math.max(1, Math.ceil((rate.resetAt - now) / 1000)))
  }
  return rate
}

export class RateLimitedError extends ApiError {
  constructor(
    readonly rate: RateLimit,
    readonly retryAfterSeconds: number
  ) {
    super(429, 'rate_limited')
  }
}

export function rateHeaders(rate: RateLimit): Record<string, string> {
  return {
    'x-ratelimit-limit': String(rate.limit),
    'x-ratelimit-remaining': String(rate.remaining),
    'x-ratelimit-reset': String(Math.ceil(rate.resetAt / 1000))
  }
}
