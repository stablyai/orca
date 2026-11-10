// Auth's role-changed and member-removed pushes are recorded here, so a desktop token minted before
// the change (valid up to 15 minutes) can't write the old role or membership back: no re-raising a
// demoted member's keys or phones, and no enrolling a phone after removal.
import type { SandboxCaller } from './auth'

// Auth's own clock mints the tokens, so its change time is the one to compare `iat` with; a time
// further ahead than a token can live (15 min) is clamped so a bad clock can't lock someone out long.
const MAX_AHEAD_MS = 15 * 60_000

/** When the change counts from: the later of auth's reported time (if sent) and our receipt. */
export function memberChangeTime(now: number, reportedAt?: number): number {
  return reportedAt === undefined ? now : Math.max(now, Math.min(reportedAt, now + MAX_AHEAD_MS))
}

export async function recordMemberChange(
  db: D1Database,
  accountId: string,
  userId: string,
  kind: 'role' | 'removed',
  now: number
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO member_changes (account_id, user_id, changed_at, removed_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, user_id) DO UPDATE SET changed_at = excluded.changed_at,
         removed_at = COALESCE(excluded.removed_at, member_changes.removed_at)`
    )
    .bind(accountId, userId, now, kind === 'removed' ? now : null)
    .run()
}

/**
 * True when this desktop token was issued at or before the member's last change in its account
 * (`iat` has second precision, so a token from the same second counts as stale). Device tokens
 * and personal accounts never predate a change: their identity is not pushed by auth.
 */
export async function tokenPredatesMemberChange(db: D1Database, caller: SandboxCaller): Promise<boolean> {
  if (caller.tokenIssuedAt === undefined || caller.deviceSessionId || !caller.orgId) {
    return false
  }
  const row = await db
    .prepare('SELECT changed_at FROM member_changes WHERE account_id = ? AND user_id = ?')
    .bind(caller.accountId, caller.userId)
    .first<{ changed_at: number }>()
  return row !== null && caller.tokenIssuedAt <= row.changed_at
}

/**
 * True when this org desktop token was issued at or before the member was removed from its account:
 * a removed member's still-unexpired token must not mint keys, approvals or grants after the purge.
 * A member added back gets tokens issued after the removal, which pass.
 */
export async function tokenPredatesRemoval(db: D1Database, caller: SandboxCaller): Promise<boolean> {
  if (caller.tokenIssuedAt === undefined || caller.deviceSessionId || !caller.orgId) {
    return false
  }
  const row = await db
    .prepare('SELECT removed_at FROM member_changes WHERE account_id = ? AND user_id = ?')
    .bind(caller.accountId, caller.userId)
    .first<{ removed_at: number | null }>()
  return row?.removed_at != null && caller.tokenIssuedAt <= row.removed_at
}

/** True once auth reported this user removed from the account (a later re-add is not recorded). */
export async function creatorLeftAccount(db: D1Database, accountId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT removed_at FROM member_changes WHERE account_id = ? AND user_id = ?')
    .bind(accountId, userId)
    .first<{ removed_at: number | null }>()
  return row?.removed_at != null
}
