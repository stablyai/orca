// Keys and MCP grants act as the member who made them, capped by that member's role. The role is
// stored on the key (`creator_role`) and re-synced whenever it changes, so a demoted admin's keys
// and grants lose admin-only scopes at once (the cap is applied at every authentication).
// Two triggers: auth's internal call on a role change (POST /v1/internal/members/role-changed), and
// the member's own signed-in requests, which carry the live role (self-heal if a call was missed).
// Departures are handled by /v1/internal/members/removed (revokes keys, grants, routines).
import type { OrgRole } from '../auth'
import { audit } from './audit'

const SYNC_INTERVAL_MS = 60_000
/** Per-isolate throttle: at most one sync write per member per minute from request traffic. */
const lastSynced = new Map<string, { role: OrgRole; at: number }>()

/** Sets the cap on every live key and grant the member made in the account; returns rows changed. */
export async function syncMemberRole(db: D1Database, accountId: string, userId: string, role: OrgRole): Promise<number> {
  // The stored cap changed out of band: the next signed-in request must compare again.
  lastSynced.delete(`${accountId}\u0000${userId}`)
  const result = await db
    .prepare(
      `UPDATE api_keys SET creator_role = ?
       WHERE account_id = ? AND created_by = ? AND revoked_at IS NULL AND kind <> 'workspace'
         AND (creator_role IS NULL OR creator_role <> ?)`
    )
    .bind(role, accountId, userId, role)
    .run()
  return result.meta.changes
}

/** From a signed-in org request: bring the member's keys in line with the role their token carries. */
export async function syncRoleFromSession(
  db: D1Database,
  caller: { accountId: string; userId: string; orgId?: string; orgRole?: OrgRole },
  now: number
): Promise<void> {
  if (!caller.orgId) {
    return
  }
  const role: OrgRole = caller.orgRole ?? 'member'
  const cacheKey = `${caller.accountId}\u0000${caller.userId}`
  const seen = lastSynced.get(cacheKey)
  if (seen && seen.role === role && now - seen.at < SYNC_INTERVAL_MS) {
    return
  }
  const changed = await syncMemberRole(db, caller.accountId, caller.userId, role)
  lastSynced.set(cacheKey, { role, at: now })
  if (changed > 0) {
    await audit(db, { accountId: caller.accountId, type: 'system', id: 'role-sync', userId: caller.userId }, { action: 'member.role_synced', detail: { role, keysUpdated: changed } }, now)
  }
}
