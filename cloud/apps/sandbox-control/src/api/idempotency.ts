// Idempotency-Key (Stripe-style) for public API creates. The first request with a key claims it
// (insert-or-nothing), runs, and stores its response; a retry with the same key and body replays that
// response with `idempotent-replayed: true`. Same key, different body: 422. Retry while the first is
// still running: 409 with Retry-After. Failures that left nothing behind (4xx before any work, 5xx)
// release the key so the client can retry for real. Keys live 24h.
import { ApiError } from './caller'
import { sha256Hex } from './keys'

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000
/** A pending claim older than this belongs to a request that died; it may be taken over. */
const PENDING_STALE_MS = 3 * 60_000
const KEY = /^[A-Za-z0-9_.:\-]{8,128}$/

type Row = { request_hash: string; state: 'pending' | 'done'; status: number | null; response: string | null; created_at: number }

export function readIdempotencyKey(request: Request): string | null {
  const value = request.headers.get('idempotency-key')
  if (value === null) {
    return null
  }
  if (!KEY.test(value)) {
    throw new ApiError(400, 'invalid_request', 'idempotency_key: 8-128 chars of [A-Za-z0-9_.:-]')
  }
  return value
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

/**
 * Runs `work` at most once per (account, scope, key). `work` returns the JSON body and status to
 * store and replay. Errors thrown by `work` release the key (nothing was created) and propagate.
 */
export async function withIdempotency(
  db: D1Database,
  input: { accountId: string; scope: string; key: string | null; body: unknown; now: number },
  work: () => Promise<{ status: number; body: unknown }>
): Promise<Response> {
  const respond = (status: number, body: unknown, replayed: boolean) =>
    Response.json(body, { status, headers: { 'cache-control': 'no-store', ...(replayed ? { 'idempotent-replayed': 'true' } : {}) } })
  if (!input.key) {
    const done = await work()
    return respond(done.status, done.body, false)
  }
  const hash = await sha256Hex(canonical(input.body))
  const { accountId, scope, key, now } = input
  await db.prepare('DELETE FROM api_idempotency WHERE account_id = ? AND scope = ? AND idem_key = ? AND expires_at <= ?').bind(accountId, scope, key, now).run()
  const claimed = await db
    .prepare(
      `INSERT INTO api_idempotency (account_id, scope, idem_key, request_hash, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT DO NOTHING`
    )
    .bind(accountId, scope, key, hash, now, now + IDEMPOTENCY_TTL_MS)
    .run()
  if (claimed.meta.changes !== 1) {
    const row = await db
      .prepare('SELECT request_hash, state, status, response, created_at FROM api_idempotency WHERE account_id = ? AND scope = ? AND idem_key = ?')
      .bind(accountId, scope, key)
      .first<Row>()
    if (!row) {
      throw new ApiError(409, 'conflict', 'idempotency_in_progress')
    }
    if (row.request_hash !== hash) {
      throw new ApiError(422, 'idempotency_key_reused', 'same key, different request')
    }
    if (row.state === 'done' && row.status !== null && row.response !== null) {
      return respond(row.status, JSON.parse(row.response), true)
    }
    if (now - row.created_at < PENDING_STALE_MS) {
      throw new ApiError(409, 'conflict', 'idempotency_in_progress')
    }
    // The first attempt died mid-way: take the claim over (compare-and-set on its timestamp).
    const taken = await db
      .prepare(`UPDATE api_idempotency SET created_at = ? WHERE account_id = ? AND scope = ? AND idem_key = ? AND state = 'pending' AND created_at = ?`)
      .bind(now, accountId, scope, key, row.created_at)
      .run()
    if (taken.meta.changes !== 1) {
      throw new ApiError(409, 'conflict', 'idempotency_in_progress')
    }
  }
  let done: { status: number; body: unknown }
  try {
    done = await work()
  } catch (error) {
    await db.prepare(`DELETE FROM api_idempotency WHERE account_id = ? AND scope = ? AND idem_key = ? AND state = 'pending'`).bind(accountId, scope, key).run()
    throw error
  }
  await db
    .prepare(`UPDATE api_idempotency SET state = 'done', status = ?, response = ? WHERE account_id = ? AND scope = ? AND idem_key = ?`)
    .bind(done.status, JSON.stringify(done.body), accountId, scope, key)
    .run()
  return respond(done.status, done.body, false)
}

/** Cron: drop expired keys. */
export async function purgeIdempotency(db: D1Database, now: number): Promise<number> {
  const result = await db.prepare('DELETE FROM api_idempotency WHERE expires_at <= ?').bind(now).run()
  return result.meta.changes
}
