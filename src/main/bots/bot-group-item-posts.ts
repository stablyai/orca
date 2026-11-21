// The owner's answer or comment on an item a bot raised in a group room reaches that bot as the
// owner's post in the room, to it alone: an ordinary room turn, with the room's history, Stop and
// membership rules, instead of mail the room session can't take.
import { BOT_ITEM_MAIL_SENDER } from '../../shared/bots/bot-item-note-runs'
import type { BotGroupRuntime } from './bot-group-runtime'

/** One post per item mail, so a resend or a retry after a crash posts nothing twice. */
export function groupItemPostId(mailId: string): string {
  return `item-mail:${mailId}`
}

export type GroupItemMail = { id: string; subject: string; body: string; images: readonly string[] }

/** Posts it in the room this session talks in; false when no room has the session any more. */
export async function postGroupItemMail(
  groups: BotGroupRuntime,
  sessionId: string,
  mail: GroupItemMail
): Promise<boolean> {
  const found = groups.store.memberOf(sessionId)
  if (!found) {
    return false
  }
  await groups.send(
    {
      groupId: found.group.id,
      ...(found.threadId ? { threadId: found.threadId } : {}),
      revision: found.group.revision,
      messageId: groupItemPostId(mail.id),
      text: `${mail.subject}\n\n${mail.body}`,
      ...(mail.images.length > 0 ? { images: [...mail.images] } : {})
    },
    { to: found.member.botId }
  )
  return true
}

/** Item mail an older Orca stored for a room session, which never ran there: posted once in its
 *  room, then marked read. Left unread when that fails, to try on the next read. */
export function postStoredGroupItemMail(
  groups: BotGroupRuntime,
  sessionId: string,
  mailId: string
): void {
  const db = groups.runtime.getOrchestrationDb()
  const row = db.getMessageById(mailId)
  if (!row || row.from_handle !== BOT_ITEM_MAIL_SENDER || row.read !== 0) {
    return
  }
  const images = storedImages(row.payload)
  void postGroupItemMail(groups, sessionId, {
    id: mailId,
    subject: row.subject,
    body: row.body,
    images
  })
    .then((posted) => posted && db.markAsReadAndDelivered([mailId]))
    .catch((error: unknown) => console.warn('[bot-groups] posting stored item mail failed', error))
}

function storedImages(payload: string | null): string[] {
  try {
    const parsed: unknown = payload ? JSON.parse(payload) : null
    const images =
      parsed && typeof parsed === 'object' && 'images' in parsed ? parsed.images : undefined
    return Array.isArray(images) ? images.filter((path) => typeof path === 'string') : []
  } catch {
    return []
  }
}
