// Teammate display names from the sandbox token's `name` claim (auth sanitizes it; auth.ts trims it
// again). Each member's own authenticated request records their name for their account, so a
// teammate's list can label ids the org roster does not cover (dev orgs, members who left).
// Auth also sends names for teammates who have never used Orca Cloud in the team
// (POST /v1/internal/member-names: as people join, and a one-off backfill), so the audit log and
// its CSV export can name them.
// Labels only: access decisions never read this table (test/member-names.test.ts holds that).
import { z } from 'zod'
import type { SandboxCaller } from './auth'

/** One line of plain text, at most 80 characters, as auth.ts treats the token's name claim. */
function label(value: string): string | null {
  const clean = value.replace(/[\u0000-\u001f\u007f"\\]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)
  return clean || null
}

export const MemberNamesSchema = z
  .object({
    accountId: z.string().min(1).max(160).regex(/^(org|dev:org):[A-Za-z0-9_.:-]+$/),
    members: z
      .array(z.object({ userId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/), name: z.string().min(1).max(200) }).strict())
      .min(1)
      .max(200)
  })
  .strict()

/**
 * Saves the display names auth sent for a team's members. A name that is already the same is left
 * alone; a different one is replaced (auth is where display names are set). Returns how many rows
 * were written. Writes a label and nothing else: no membership, role or access is created here.
 */
export async function rememberMemberNames(db: D1Database, body: z.infer<typeof MemberNamesSchema>, now: number): Promise<number> {
  const statements: D1PreparedStatement[] = []
  for (const member of body.members) {
    const name = label(member.name)
    if (!name) {
      continue
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO member_names (account_id, user_id, name, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (account_id, user_id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at
           WHERE member_names.name <> excluded.name`
        )
        .bind(body.accountId, member.userId, name, now)
    )
  }
  if (statements.length === 0) {
    return 0
  }
  const results = await db.batch(statements)
  return results.reduce((sum, result) => sum + (result.meta.changes ?? 0), 0)
}

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
