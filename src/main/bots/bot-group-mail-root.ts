// Which group request a mail to a member continues, decided once for delivery and admission.
import type { BotGroupMember, BotGroupTurn } from '../../shared/bots/bot-group'
import { BotGroupPeerScopeSchema, type BotGroupPeerScope } from '../../shared/bots/bot-group-schema'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-note-runs'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import { readMessageSenderDispatch } from '../runtime/orchestration/db/messages/message-sender-dispatch'
import type { BotGroupRuntime } from './bot-group-runtime'
import { lineageAncestors } from './bot-item-dispatch-facts'

/** The group request a message's turns serve: its own, or the human post it continues. */
export const rootOf = (message: {
  id: string
  sequence: number
  rootRequestId?: string
  rootSequence?: number
}) => ({
  rootRequestId: message.rootRequestId ?? message.id,
  rootSequence: message.rootSequence ?? message.sequence
})

/** Mail that starts a request of its own: a change to the member's items, or a worker's report
 *  that lands after the request it served was stopped, which the bot's own chat reads too. */
export type OwnRequestMail = 'items' | 'reports'

/** Own-request mail's root before its line is saved: after every earlier request. */
const ownRequestRoot = (
  groupId: string,
  member: BotGroupMember,
  kind: OwnRequestMail
): BotGroupPeerScope => ({
  id: groupId,
  rootRequestId: `${kind}:${member.sessionId}`,
  rootSequence: Number.MAX_SAFE_INTEGER,
  sourceSessionId: member.sessionId,
  targetSessionId: member.sessionId
})

/** Which own request a root is, or null for mail continuing a room request. */
export function ownRequestMail(
  root: Pick<BotGroupPeerScope, 'rootRequestId'>,
  member: BotGroupMember
): OwnRequestMail | null {
  return (
    (['items', 'reports'] as const).find(
      (kind) => root.rootRequestId === `${kind}:${member.sessionId}`
    ) ?? null
  )
}

/** Own-request mail already on a line whose turn hasn't run is that line's request, which a later
 *  Stop ends; otherwise it is a new request after the Stop. */
function ownRequest(
  groups: BotGroupRuntime,
  groupId: string,
  member: BotGroupMember,
  mailId: string,
  kind: OwnRequestMail
): BotGroupPeerScope {
  const root = ownRequestRoot(groupId, member, kind)
  const line = mailLine(groups, member, mailId)
  return line && !mailTurnRan(line.turns[0]) ? { ...root, rootSequence: line.sequence } : root
}

/** The group request a mail to this member continues: a member's peer request, a report from a
 *  worker one of this member's turns started, or a new request (a change to its items, or a
 *  report from a worker whose request was stopped). */
export function mailRoot(
  groups: BotGroupRuntime,
  groupId: string,
  member: BotGroupMember,
  mail: Pick<MessageRow, 'id' | 'thread_id' | 'from_handle'>
): BotGroupPeerScope | null {
  if (mail.from_handle === BOT_ITEM_MAIL_SENDER) {
    return ownRequest(groups, groupId, member, mail.id, 'items')
  }
  const db = groups.runtime.getOrchestrationDb()
  const request =
    db.getBotRequest(mail.id) ?? (mail.thread_id ? db.getBotRequest(mail.thread_id) : undefined)
  if (request) {
    const parsed: unknown = JSON.parse(request.record)
    const scope = BotGroupPeerScopeSchema.safeParse(
      typeof parsed === 'object' && parsed !== null && 'group' in parsed ? parsed.group : null
    )
    return scope.success ? scope.data : null
  }
  // A worker's final report settles its Dispatch as it lands, so its recorded sender comes first.
  const dispatch =
    readMessageSenderDispatch(db, mail.id)?.dispatchId ??
    (mail.from_handle.startsWith('dispatch:')
      ? mail.from_handle.slice('dispatch:'.length)
      : db.getActiveDispatchForIdentity(mail.from_handle)?.id)
  // A follow-up is a new Dispatch: it serves the operation its newest bound ancestor started for.
  const operationId = dispatch
    ? (lineageAncestors(db, dispatch)
        .map((id) => groups.store.workerOperation(id))
        .find((id) => id !== null) ?? null)
    : null
  if (!operationId) {
    warnUnboundWorkerMail(mail.id, dispatch)
  }
  const message = operationId ? groups.store.operationMessage(operationId) : null
  const owned = message?.turns.some(
    (turn) => turn.operationId === operationId && turn.sessionId === member.sessionId
  )
  if (!message || !owned) {
    return null
  }
  const root = rootOf(message)
  // Stop ends the turn, not the workers it started: their later reports wake the member.
  return root.rootSequence <= (member.stoppedThroughSequence ?? 0)
    ? ownRequest(groups, groupId, member, mail.id, 'reports')
    : {
        id: message.groupId,
        ...root,
        sourceSessionId: member.sessionId,
        targetSessionId: member.sessionId
      }
}

const warnedUnboundMail = new Set<string>()

/** Held worker mail would otherwise wait silently; say so once per mail. */
function warnUnboundWorkerMail(mailId: string, dispatchId: string | undefined): void {
  // Past the cap, stay quiet rather than re-warn a backlog on every pass.
  if (warnedUnboundMail.has(mailId) || warnedUnboundMail.size >= 1000) {
    return
  }
  warnedUnboundMail.add(mailId)
  console.warn(
    `[bot-groups] holding worker mail ${mailId}: Dispatch ${dispatchId ?? '(none)'} serves no room request`
  )
}

/** Whether a mail line's turn ran, by what the line itself saved: its reply, or its retirement. */
export function mailTurnRan(turn: BotGroupTurn | undefined): boolean {
  return (
    turn === undefined ||
    turn.reply !== undefined ||
    turn.revoked === true ||
    turn.frozenItems !== undefined
  )
}

/** The newest line a member's mail turn took `mailId` on: its id is `mail:<sessionId>:<ids>[#n]`. */
function mailLine(groups: BotGroupRuntime, member: BotGroupMember, mailId: string) {
  const prefix = `mail:${member.sessionId}:`
  const id = groups.store.db
    .prepare(
      `SELECT id FROM bot_group_messages WHERE id >= ? AND id < ? AND instr(id, ?) > 0
       ORDER BY sequence DESC`
    )
    .all(prefix, `${prefix}\uffff`, mailId)
    .map((row) => String(row.id))
    .find((candidate) =>
      candidate.slice(prefix.length).split('#', 1)[0]?.split(',').includes(mailId)
    )
  return id ? groups.store.message(id) : null
}
