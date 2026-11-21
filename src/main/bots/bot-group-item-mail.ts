// Orca's own item mail to a member's room session: its owner answered or commented on an item of the
// member's. Each such mail gets its own room line, written as Orca stores the mail, and that line is
// the request the mail's turn serves: a Stop before it never ends it, and its root never moves.
import type { BotGroupMember, BotGroupPeerScope } from '../../shared/bots/bot-group-schema'
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-note-runs'
import type { BotGroupRuntime } from './bot-group-runtime'

/** The room line a mail turn runs on: the one reserveGroupMailTurn keys by its mail. */
export function groupMailLineId(sessionId: string, mailIds: readonly string[]): string {
  return `mail:${sessionId}:${mailIds.join(',')}`
}

/** Writes the room line for item mail about to go to a room session; false when the session is no
 *  room's member any more, so the mail goes to the bot's Home chat instead. */
export function anchorGroupItemMail(
  groups: BotGroupRuntime,
  sessionId: string,
  mailId: string
): boolean {
  const found = groups.store.memberOf(sessionId)
  const bot = found && groups.runtime.bots.list().find((entry) => entry.id === found.member.botId)
  if (!found || !bot) {
    return false
  }
  const id = groupMailLineId(sessionId, [mailId])
  if (!groups.store.message(id)) {
    groups.store.append({
      id,
      groupId: found.group.id,
      ...(found.threadId ? { threadId: found.threadId } : {}),
      author: { kind: 'bot', id: bot.id, name: bot.name },
      text: `${bot.name} followed up`,
      createdAt: Date.now(),
      turns: [
        {
          // Until the mail lane admits it under its own id (reserveGroupMailTurn retargets it).
          operationId: `item-mail:${mailId}`,
          botId: bot.id,
          botName: bot.name,
          avatar: bot.avatar,
          ...(bot.avatarColor ? { avatarColor: bot.avatarColor } : {}),
          agent: bot.agent,
          sessionId,
          mailbox: true
        }
      ]
    })
    groups.changed()
  }
  return true
}

/** The request item mail continues: its own room line. Null for mail that has none. */
export function itemMailRoot(
  groups: BotGroupRuntime,
  member: BotGroupMember,
  mailId: string
): BotGroupPeerScope | null {
  const line = groups.store.message(groupMailLineId(member.sessionId, [mailId]))
  return line
    ? {
        id: line.groupId,
        rootRequestId: line.id,
        rootSequence: line.sequence,
        sourceSessionId: member.sessionId,
        targetSessionId: member.sessionId
      }
    : null
}

/** Whether mail a Stop ended may be retired. Item mail is the owner's word all the same, so it goes
 *  on to the bot's Home chat first; while that chat doesn't exist yet it stays owed here. */
export function groupMailMayEnd(
  groups: BotGroupRuntime,
  member: BotGroupMember,
  ended: { id: string; from_handle: string }
): boolean {
  if (ended.from_handle !== BOT_ITEM_MAIL_SENDER) {
    return true
  }
  const { runtime } = groups
  const db = runtime.getOrchestrationDb()
  const mail = db.getMessageById(ended.id)
  const home = runtime.bots.list().find((entry) => entry.id === member.botId)?.chatSessionId
  if (!mail || !home) {
    return false
  }
  const id = `${ended.id}:home`
  const to = `orca_session_id:${home}`
  if (!db.getMessageById(id)) {
    db.insertMessage({
      id,
      from: BOT_ITEM_MAIL_SENDER,
      to,
      type: mail.type,
      subject: mail.subject,
      body: mail.body,
      ...(mail.payload ? { payload: mail.payload } : {}),
      orcaAuthored: 'item-mail'
    })
    runtime.notifyMessageArrived(to, mail.type)
  }
  return true
}
