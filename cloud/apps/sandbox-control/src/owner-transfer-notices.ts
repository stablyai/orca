// Telling the previous owner that their workspace changed owner (OWNER-TRANSFER). Everything on
// its disk went with it, so personal secrets they used there may still be on it: they are told,
// and advised to rotate.
//
//   GET  /v1/team/notices                 -> {notices: [...]}   the caller's own, not yet dismissed
//   POST /v1/team/notices/:id/dismiss     -> {dismissed: true}
//
// Three parts, all after the hand-off is complete and none able to block or undo it:
//   1. a notice stored here, which the desktop shows the previous owner (migration 0060);
//   2. an email, asked of Orca Cloud auth (the control plane has no addresses and no sender).
//      Auth resolves the address and the names itself. Today auth only records the request: it
//      delivers to no real address, so `emailed` is false everywhere until that changes;
//   3. an audit row saying whether anything actually reached them.
import { z } from 'zod'
import { randomId } from './api/keys'
import type { SandboxCaller } from './auth'
import type { Env } from './env'
import { memberNamesFor } from './member-names'
import type { SandboxRow } from './store'
import { derivedAuthKey, type TeamMembershipCheck } from './team-membership'

export const NOTIFY_KEY_PURPOSE = 'orca-cloud:control-plane-to-auth:notify-workspace-transferred:v1'
const TIMEOUT_MS = 6_000
/**
 * A notice is kept this long, read or not, then gone. Removing a member does not remove theirs
 * (it is how they learn to rotate if they come back); deleting the team does (team-delete.ts).
 */
export const NOTICE_RETENTION_MS = 90 * 24 * 60 * 60_000

export type TransferEmail = { emailed: boolean; mode: string | null; reason: string | null }
export type TransferEmailRequest = {
  accountId: string
  eventId: string
  previousOwnerUserId: string
  actorUserId: string
  newOwnerUserId: string
  workspaceName: string | null
  workspaceNumber: number | null
}
export type TransferNotifier = (request: TransferEmailRequest) => Promise<TransferEmail>

const Answer = z.looseObject({ sent: z.boolean(), mode: z.string().max(32).optional(), reason: z.string().max(64).optional() })

/** Asks auth to email the previous owner. Never throws: any failure is "not emailed". */
export function createTransferNotifier(env: Pick<Env, 'AUTH_INTERNAL_ORIGIN' | 'MEMBER_REMOVED_TOKEN'>, fetchImpl: typeof fetch = fetch): TransferNotifier {
  return async (request) => {
    const origin = env.AUTH_INTERNAL_ORIGIN?.replace(/\/+$/, '')
    const token = env.MEMBER_REMOVED_TOKEN?.trim()
    if (!origin || !origin.startsWith('https://') || !token || token.length < 32 || !request.accountId.startsWith('org:')) {
      return { emailed: false, mode: null, reason: 'not_configured' }
    }
    try {
      const response = await fetchImpl(`${origin}/v1/internal/notify/workspace-transferred`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await derivedAuthKey(token, NOTIFY_KEY_PURPOSE)}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          eventId: request.eventId,
          orgId: request.accountId.slice('org:'.length),
          previousOwnerUserId: request.previousOwnerUserId,
          actorUserId: request.actorUserId,
          newOwnerUserId: request.newOwnerUserId,
          // Raw: auth cleans and caps it, and treats it as untrusted text.
          workspaceName: request.workspaceName ? request.workspaceName.slice(0, 1024) : null,
          workspaceNumber: request.workspaceNumber
        }),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => undefined)
        return { emailed: false, mode: null, reason: `auth_${response.status}` }
      }
      const parsed = Answer.safeParse(await response.json().catch(() => null))
      if (!parsed.success) {
        return { emailed: false, mode: null, reason: 'unreadable_answer' }
      }
      // "Sent" in log mode is a record, not a delivery, and an answer that names no mode proves
      // nothing: only a send in a named, non-log mode counts.
      const mode = parsed.data.mode ?? null
      return { emailed: parsed.data.sent && mode !== null && mode !== 'log', mode, reason: parsed.data.reason ?? null }
    } catch {
      return { emailed: false, mode: null, reason: 'unreachable' }
    }
  }
}

type NoticeRow = {
  id: string
  account_id: string
  user_id: string
  sandbox_id: string
  workspace_name: string | null
  workspace_number: number | null
  actor_user_id: string
  new_owner_user_id: string
  created_at: number
}

export type TransferOutcome = {
  noticeId: string
  /** The previous owner is in the team now, so the notice can reach them in Orca. */
  inApp: boolean
  email: TransferEmail
  /** Something actually reached them: the notice (they can open the team) or a delivered email. */
  reached: boolean
}

/**
 * Stores the notice and asks for the email. Called once the hand-off is written. `stillMember`
 * is auth's live answer for the previous owner; when it cannot say, the notice is still stored
 * (they see it if they can sign in to the team) but is not counted as having reached them.
 */
export async function notifyPreviousOwner(
  db: D1Database,
  input: { before: SandboxRow; after: SandboxRow; actorUserId: string; now: number },
  deps: { email: TransferNotifier; membership: TeamMembershipCheck }
): Promise<TransferOutcome> {
  const { before, after, actorUserId, now } = input
  const noticeId = randomId('otn')
  // Expired notices of this team go when a new one is written: no separate sweep to forget.
  await db
    .prepare('DELETE FROM owner_transfer_notices WHERE account_id = ? AND created_at < ?')
    .bind(before.account_id, now - NOTICE_RETENTION_MS)
    .run()
    .catch(() => undefined)
  await db
    .prepare(
      `INSERT INTO owner_transfer_notices (id, account_id, user_id, sandbox_id, workspace_name, workspace_number, actor_user_id, new_owner_user_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(noticeId, before.account_id, before.user_id, before.id, before.name, before.number ?? null, actorUserId, after.user_id, now)
    .run()
  // They did it themselves: they are signed in to the team right now.
  const stillMember =
    actorUserId === before.user_id
      ? true
      : await deps.membership(before.account_id, before.user_id).then(
          (answer) => 'member' in answer && answer.member,
          () => false
        )
  const email = await deps
    .email({
      accountId: before.account_id,
      // Stable per hand-off, so a retry is the same event at auth.
      eventId: `wst_${before.id}_${after.ownership_transferred_at ?? now}`,
      previousOwnerUserId: before.user_id,
      actorUserId,
      newOwnerUserId: after.user_id,
      workspaceName: before.name,
      workspaceNumber: before.number ?? null
    })
    .catch((): TransferEmail => ({ emailed: false, mode: null, reason: 'unreachable' }))
  return { noticeId, inApp: stillMember, email, reached: stillMember || email.emailed }
}

/** The caller's own notices in the team they are signed in to, newest first. Never one past its 90 days. */
export async function listNotices(db: D1Database, caller: SandboxCaller, now: number) {
  const { results } = await db
    .prepare(
      `SELECT id, account_id, user_id, sandbox_id, workspace_name, workspace_number, actor_user_id, new_owner_user_id, created_at
         FROM owner_transfer_notices WHERE account_id = ? AND user_id = ? AND dismissed_at IS NULL AND created_at >= ?
        ORDER BY created_at DESC LIMIT 50`
    )
    .bind(caller.accountId, caller.userId, now - NOTICE_RETENTION_MS)
    .all<NoticeRow>()
  const names = await memberNamesFor(db, caller.accountId, results.flatMap((row) => [row.actor_user_id, row.new_owner_user_id]))
  return {
    notices: results.map((row) => ({
      id: row.id,
      kind: 'workspace_owner_changed' as const,
      workspace: { id: row.sandbox_id, name: row.workspace_name, number: row.workspace_number },
      actor: { userId: row.actor_user_id, name: names.get(row.actor_user_id) ?? null },
      newOwner: { userId: row.new_owner_user_id, name: names.get(row.new_owner_user_id) ?? null },
      at: row.created_at
    }))
  }
}

/** Only the person the notice is for can dismiss it. */
export async function dismissNotice(db: D1Database, caller: SandboxCaller, id: string, now: number): Promise<boolean> {
  const result = await db
    .prepare('UPDATE owner_transfer_notices SET dismissed_at = ? WHERE id = ? AND account_id = ? AND user_id = ? AND dismissed_at IS NULL')
    .bind(now, id, caller.accountId, caller.userId)
    .run()
  return (result.meta.changes ?? 0) > 0
}
