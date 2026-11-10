// Teammate display names from the sandbox token's `name` claim (auth sanitizes it; auth.ts trims it
// again). Each member's own authenticated request records their name for their account, so a
// teammate's list can label ids the org roster does not cover (dev orgs, members who left).
// Labels only: access decisions never read this table.
import type { SandboxCaller } from './auth'

/** Records the caller's current name; a no-op write when it has not changed. */
export async function rememberCallerName(db: D1Database, caller: SandboxCaller, now: number): Promise<void> {
  if (!caller.name) {
    return
  }
  await db
    .prepare(
      `INSERT INTO member_names (account_id, user_id, name, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
       WHERE member_names.name <> excluded.name`
    )
    .bind(caller.accountId, caller.userId, caller.name, now)
    .run()
}

/** Names known for these ids in the caller's account (ids without one are left out). */
export async function memberNamesFor(
  db: D1Database,
  accountId: string,
  userIds: Iterable<string>
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)]
  const out = new Map<string, string>()
  // D1 caps bound parameters per statement; chunk well under it.
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90)
    const { results } = await db
      .prepare(`SELECT user_id, name FROM member_names WHERE account_id = ? AND user_id IN (${chunk.map(() => '?').join(', ')})`)
      .bind(accountId, ...chunk)
      .all<{ user_id: string; name: string }>()
    for (const r of results) {
      out.set(r.user_id, r.name)
    }
  }
  return out
}
