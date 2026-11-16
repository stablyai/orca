// What counts as a shared workspace when deciding whose credentials a session may carry. One
// definition, used by secrets, agent accounts, the egress proxy and the member git rules.
import type { SandboxRow } from './store'
import { teamSharingEnabled } from './team-sharing'

/**
 * D13: a workspace shared with teammates never uses a personal account. Fails closed: only a row
 * known to be private counts as unshared.
 * OWNER-TRANSFER: a workspace whose owner was ever changed is in shared mode for good. Its disk was
 * set up by someone else, and whatever they left there runs when the new owner uses it, so nothing
 * personal to the new owner is ever attached. A fresh workspace is the way to use personal credentials.
 */
export function isSharedWorkspace(row: Pick<SandboxRow, 'visibility' | 'ownership_transferred_at'>): boolean {
  return row.visibility !== 'private' || row.ownership_transferred_at != null
}

/**
 * The rule above, precisely, for callers that can read the database (all of them today). TEAM-SHARING hold: a
 * workspace stored as `team` acts private while sharing is held, but keeps shared mode until no one but its
 * owner holds a device grant on it (the hold's sweep revokes them, grants.ts sweepHeldTeamGrants), and none was
 * revoked during the current session (what a teammate started there may still run): personal credentials never
 * reach a VM a teammate may still be paired to or running in. Fails closed on a failed read.
 */
export async function sharedWorkspaceMode(
  db: D1Database,
  row: Pick<SandboxRow, 'id' | 'user_id' | 'visibility' | 'ownership_transferred_at'>
): Promise<boolean> {
  if (row.ownership_transferred_at != null) {
    return true
  }
  if (row.visibility !== 'private' && (teamSharingEnabled() || row.visibility !== 'team')) {
    return true
  }
  // Private, or `team` while held: shared only while a teammate's grant is live or was revoked this session
  // (Make private and the hold's sweep alike).
  // Review M1: a revoke closes a teammate's connections, not what they left running in this session's
  // terminals. A grant revoked during the current session keeps it shared until the next boot.
  // The session start is read here, not from the caller's row (which may be a partial or older copy). A revoke
  // queued while the workspace slept (no session) counts for nothing: the next boot applies it before orcad
  // accepts a sign-in, and that boot's processes are all new, so its session can be private. Its revoked_at
  // is when it was queued (revokeGrants; markRevoked keeps it), so it never reads as "revoked this session".
  // Unknown (null) falls back to the apply time there.
  const others = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM workspace_grants g JOIN sandboxes s ON s.id = g.sandbox_id WHERE g.sandbox_id = ? AND g.user_id <> ?
       AND (g.status IN ('issuing', 'active')
            OR (g.status = 'revoking' AND s.session_started_at IS NOT NULL)
            OR (s.session_started_at IS NOT NULL AND g.revoked_at IS NOT NULL AND g.revoked_at >= s.session_started_at))`
    )
    .bind(row.id, row.user_id)
    .first<{ n: number }>()
    .catch(() => null)
  return !others || others.n > 0
}

