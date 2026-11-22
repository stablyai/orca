// Which group request a mail to a member continues, decided once for delivery and admission.
import type { BotGroupMember } from '../../shared/bots/bot-group'
import { BotGroupPeerScopeSchema, type BotGroupPeerScope } from '../../shared/bots/bot-group-schema'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-note-runs'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import { readMessageSenderDispatch } from '../runtime/orchestration/db/messages/message-sender-dispatch'
import type { BotGroupRuntime } from './bot-group-runtime'

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

/** Item mail's root before its line is saved: a request of its own, after every earlier one. */
export const itemsRoot = (groupId: string, member: BotGroupMember): BotGroupPeerScope => ({
  id: groupId,
  rootRequestId: `items:${member.sessionId}`,
  rootSequence: Number.MAX_SAFE_INTEGER,
  sourceSessionId: member.sessionId,
  targetSessionId: member.sessionId
})

/** The group request a mail to this member continues: a member's peer request, a report from a
 *  worker one of this member's turns started, or a change to its items (a new request). */
export function mailRoot(
  groups: BotGroupRuntime,
  groupId: string,
  member: BotGroupMember,
  mail: Pick<MessageRow, 'id' | 'thread_id' | 'from_handle'>
): BotGroupPeerScope | null {
  if (mail.from_handle === BOT_ITEM_MAIL_SENDER) {
    return itemsRoot(groupId, member)
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
  const operationId = dispatch ? groups.store.workerOperation(dispatch) : null
  const message = operationId ? groups.store.operationMessage(operationId) : null
  const owned = message?.turns.some(
    (turn) => turn.operationId === operationId && turn.sessionId === member.sessionId
  )
  return message && owned
    ? {
        id: message.groupId,
        ...rootOf(message),
        sourceSessionId: member.sessionId,
        targetSessionId: member.sessionId
      }
    : null
}
