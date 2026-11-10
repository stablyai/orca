// A member left or was removed from an account. Auth may call either removal route
// (/v1/internal/org-members/removed or /v1/internal/members/removed); both run all of this, so
// nothing of theirs keeps acting for them whichever one arrives.
import { audit } from './api/audit'
import { revokeMemberDeviceSessions } from './device-sessions'
import { revokeGrantsForMember } from './grants'
import type { LifecycleDeps } from './lifecycle'
import { memberChangeTime, recordMemberChange } from './member-changes'
import { disableMemberRoutines } from './routines/runs'

export type MemberRemoval = {
  keysRevoked: number
  devicesRevoked: number
  grantsRevoked: number
  grantsQueued: number
  routinesDisabled: number
}

export async function removeMember(
  life: LifecycleDeps,
  accountId: string,
  userId: string,
  now: number,
  reportedAt?: number
): Promise<MemberRemoval> {
  // First, so their desktop tokens minted before this stop working (and can't enroll or re-sync).
  await recordMemberChange(life.db, accountId, userId, 'removed', memberChangeTime(now, reportedAt))
  // A key acts as the person who made it: once they leave, none of theirs may work.
  const keys = await life.db
    .prepare(`UPDATE api_keys SET revoked_at = ?, revoked_by = 'system:member_removed' WHERE account_id = ? AND created_by = ? AND revoked_at IS NULL`)
    .bind(now, accountId, userId)
    .run()
  // MCP OAuth tokens are api_keys rows (revoked above); pending codes and approvals die too.
  await life.db.batch([
    life.db.prepare('UPDATE oauth_codes SET consumed_at = ? WHERE account_id = ? AND user_id = ? AND consumed_at IS NULL').bind(now, accountId, userId),
    life.db.prepare('UPDATE oauth_approvals SET consumed_at = ? WHERE account_id = ? AND user_id = ? AND consumed_at IS NULL').bind(now, accountId, userId)
  ])
  // Their phones sign as them; then every workspace device they were granted (phones' included).
  const devicesRevoked = await revokeMemberDeviceSessions(life.db, accountId, userId, now)
  const grants = await revokeGrantsForMember(life, accountId, userId)
  // Routines run with their creator's secrets: a departed member's stop, and nothing of theirs keeps running.
  const routines = await disableMemberRoutines({ life }, accountId, userId)
  const result = {
    keysRevoked: keys.meta.changes,
    devicesRevoked,
    grantsRevoked: grants.revoked,
    grantsQueued: grants.queued,
    routinesDisabled: routines.disabled
  }
  await audit(life.db, { accountId, type: 'system', id: 'auth', userId }, { action: 'member.removed', detail: { ...result, runsCancelled: routines.cancelled } }, now)
  return result
}
