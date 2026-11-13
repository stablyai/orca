// A member left or was removed from an account. Auth may call either removal route
// (/v1/internal/org-members/removed or /v1/internal/members/removed); both run all of this, so
// nothing of theirs keeps acting for them whichever one arrives.
import { audit } from './api/audit'
import { revokeMemberDeviceSessions } from './device-sessions'
import { revokeGrantsForMember } from './grants'
import type { LifecycleDeps } from './lifecycle'
import { memberChangeTime, recordMemberChange } from './member-changes'
import { revokeMemberReaderKeys } from './read-snapshots'
import { disableMemberRoutines } from './routines/runs'
import { forgetMemberPokes } from './team-presence'

export type MemberRemoval = {
  keysRevoked: number
  devicesRevoked: number
  grantsRevoked: number
  grantsQueued: number
  routinesDisabled: number
  readerKeysRevoked: number
}

/**
 * The audit actor for a membership event auth pushed: the person who made the change when auth
 * names one, else the system with the affected member in user_id (how older rows were written).
 */
export function memberEventActor(accountId: string, memberId: string, actorUserId?: string) {
  return actorUserId
    ? { accountId, type: 'user', id: actorUserId, userId: actorUserId }
    : { accountId, type: 'system', id: 'auth', userId: memberId }
}

/** With a named actor the member is the target; without one they stay in user_id (see above). */
export function memberEventTarget(memberId: string, actorUserId?: string): { targetType?: string; targetId?: string } {
  return actorUserId ? { targetType: 'member', targetId: memberId } : {}
}

export async function removeMember(
  life: LifecycleDeps,
  accountId: string,
  userId: string,
  now: number,
  reportedAt?: number,
  /** Who removed them in auth, when it says; the same id means they left by themselves. */
  actorUserId?: string
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
  // No device of theirs can open a sleeping workspace's read snapshot again (wrapped keys deleted).
  const readerKeysRevoked = await revokeMemberReaderKeys(life.db, accountId, userId, now)
  // Their Pokes opt-in goes (it doubles as proof of membership for receiving one).
  await forgetMemberPokes(life.db, accountId, userId, now)
  const grants = await revokeGrantsForMember(life, accountId, userId)
  // Routines run with their creator's secrets: a departed member's stop, and nothing of theirs keeps running.
  const routines = await disableMemberRoutines({ life }, accountId, userId)
  const result = {
    keysRevoked: keys.meta.changes,
    devicesRevoked,
    grantsRevoked: grants.revoked,
    grantsQueued: grants.queued,
    routinesDisabled: routines.disabled,
    readerKeysRevoked
  }
  await audit(
    life.db,
    memberEventActor(accountId, userId, actorUserId),
    { action: actorUserId === userId ? 'member.left' : 'member.removed', ...memberEventTarget(userId, actorUserId), detail: { ...result, runsCancelled: routines.cancelled } },
    now
  )
  return result
}
