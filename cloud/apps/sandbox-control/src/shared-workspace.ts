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
 * owner holds a device grant on it (the hold's sweep revokes them, grants.ts sweepHeldTeamGrants): personal
 * credentials never reach a VM a teammate may still be paired to. Fails closed on a failed read.
 */
export async function sharedWorkspaceMode(
  db: D1Database,
  row: Pick<SandboxRow, 'id' | 'user_id' | 'visibility' | 'ownership_transferred_at'>
): Promise<boolean> {
  if (row.ownership_transferred_at != null || row.visibility === 'private') {
    return row.ownership_transferred_at != null
  }
  if (teamSharingEnabled() || row.visibility !== 'team') {
    return true
  }
  const others = await db
    .prepare(`SELECT COUNT(*) AS n FROM workspace_grants WHERE sandbox_id = ? AND user_id <> ? AND status IN ('issuing', 'active', 'revoking')`)
    .bind(row.id, row.user_id)
    .first<{ n: number }>()
    .catch(() => null)
  return !others || others.n > 0
}

