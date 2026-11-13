// PARITY-FOLLOW: persistent Follow on a team workspace (Conductor's Following section and
// follower avatars).
//   PUT    /v1/team/workspaces/:id/follow   -> {following: true, followers}
//   DELETE /v1/team/workspaces/:id/follow   -> {following: false, followers}
// Anyone who can see a workspace may follow it, and sees who else follows it (team workspaces are
// visible to the whole team). A private workspace's only viewer is its owner, so a teammate's old
// follow of a workspace that turned private is never shown and never counts. Archived workspaces
// may still be followed: they stay browsable.
import type { SandboxCaller } from './auth'
import type { SandboxRow } from './store'

/** Followers of each workspace, oldest follow first. */
export async function followersFor(db: D1Database, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (ids.length === 0) {
    return out
  }
  const { results } = await db
    .prepare(
      `SELECT sandbox_id, user_id FROM workspace_follows WHERE sandbox_id IN (${ids.map(() => '?').join(', ')})
       ORDER BY created_at ASC, user_id ASC`
    )
    .bind(...ids)
    .all<{ sandbox_id: string; user_id: string }>()
  for (const row of results) {
    const list = out.get(row.sandbox_id) ?? []
    list.push(row.user_id)
    out.set(row.sandbox_id, list)
  }
  return out
}

/**
 * The followers a caller may be shown for a row: none unless the caller can see it (`seen`); for a
 * private row, only its owner (the only member who can see it).
 */
export function visibleFollowers(
  row: Pick<SandboxRow, 'visibility' | 'user_id'>,
  seen: boolean,
  followers: readonly string[]
): string[] {
  if (!seen) {
    return []
  }
  return row.visibility === 'team' ? [...followers] : followers.filter((id) => id === row.user_id)
}

/** The caller must be able to see the row (the route checks canSee first). */
export async function setFollow(
  db: D1Database,
  caller: SandboxCaller,
  row: SandboxRow,
  follow: boolean,
  now: number
): Promise<{ following: boolean; followers: string[] }> {
  if (follow) {
    await db
      .prepare(
        `INSERT INTO workspace_follows (sandbox_id, user_id, account_id, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (sandbox_id, user_id) DO NOTHING`
      )
      .bind(row.id, caller.userId, row.account_id, now)
      .run()
  } else {
    await db.prepare('DELETE FROM workspace_follows WHERE sandbox_id = ? AND user_id = ?').bind(row.id, caller.userId).run()
  }
  const followers = visibleFollowers(row, true, (await followersFor(db, [row.id])).get(row.id) ?? [])
  return { following: followers.includes(caller.userId), followers }
}

/** The workspace is gone: nobody follows it any more. */
export async function forgetWorkspaceFollows(db: D1Database, sandboxId: string): Promise<void> {
  await db.prepare('DELETE FROM workspace_follows WHERE sandbox_id = ?').bind(sandboxId).run()
}

/** The member left the account: their follows go, and they stop showing as a follower. */
export async function forgetMemberFollows(db: D1Database, accountId: string, userId: string): Promise<number> {
  const result = await db.prepare('DELETE FROM workspace_follows WHERE account_id = ? AND user_id = ?').bind(accountId, userId).run()
  return result.meta.changes
}
