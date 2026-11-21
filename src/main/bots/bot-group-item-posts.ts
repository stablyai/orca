// The owner's answer or comment on an item a bot raised in a group room reaches that bot as the
// owner's post in the room, to it alone: an ordinary room turn, with the room's history, Stop and
// membership rules, instead of mail the room session can't take.
import { BOT_GROUP_CHANGED, deliverTurn } from './bot-group-delivery'
import type { BotGroupRuntime } from './bot-group-runtime'

/** One post per item change: a resend or a retry after a crash finds it and posts nothing again. */
export function groupItemPostId(mailId: string): string {
  return `item-mail:${mailId}`
}

export type GroupItemMail = { id: string; subject: string; body: string; images: readonly string[] }

/** A room's membership or settings changed between reading and posting: read again, a few times. */
const REVISION_ATTEMPTS = 3

/**
 * Posts the change in the room this session talks in and waits for the bot's turn to be admitted.
 * True once a post answers for it; false when it must go to the bot's Home chat instead: no room
 * has the session, or the room refused the turn before it ran (stopped, removed, paused, no host).
 */
export async function postGroupItemMail(
  groups: BotGroupRuntime,
  sessionId: string,
  mail: GroupItemMail
): Promise<boolean> {
  const id = groupItemPostId(mail.id)
  // A post made before (a retry, or a send that stored it and then failed) answers for this change,
  // whatever its member or the item's title is now.
  if (!groups.store.message(id) && !(await post(groups, sessionId, id, mail))) {
    return false
  }
  const stored = groups.store.message(id)
  if (!stored) {
    return false
  }
  // A post this call made was admitted already; an earlier one still owed is delivered now.
  await Promise.all(stored.turns.map((turn) => deliverTurn(groups, stored, turn)))
  // Only a turn refused before it ran carries an error; one that ran and failed does not.
  return !groups.store.message(id)?.turns.some((turn) => turn.error !== undefined)
}

async function post(
  groups: BotGroupRuntime,
  sessionId: string,
  id: string,
  mail: GroupItemMail
): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    const found = groups.store.memberOf(sessionId)
    const bot = found && groups.runtime.bots.list().find((entry) => entry.id === found.member.botId)
    if (!found || !bot) {
      return false
    }
    try {
      await groups.send(
        {
          groupId: found.group.id,
          ...(found.threadId ? { threadId: found.threadId } : {}),
          revision: found.group.revision,
          messageId: id,
          // Named, so the room's other members read whom the owner answered.
          text: `@${bot.name} ${mail.subject}\n\n${mail.body}`,
          ...(mail.images.length > 0 ? { images: [...mail.images] } : {})
        },
        { to: bot.id, awaitDelivery: true }
      )
      return true
    } catch (error) {
      if (groups.store.message(id)) {
        // Stored before it failed: the post answers for the change, so it never goes Home as well.
        return true
      }
      const changed = error instanceof Error && error.message === BOT_GROUP_CHANGED
      if (!changed || attempt >= REVISION_ATTEMPTS) {
        // Nothing was posted: the room can't take it, so Home does.
        console.warn('[bot-groups] posting an item change in its room failed', error)
        return false
      }
    }
  }
}
