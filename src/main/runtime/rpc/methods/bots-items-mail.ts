// What one write changed on a chat's items, when that chat didn't make it: one orchestration mail to
// that chat (or Home Chat when it takes no mail). Stored under its first event's id, so a repeat finds
// it and sends nothing; mail's own custody then delivers it and recovers it after a crash.
import type { Bot } from '../../../../shared/bot-types'
import { botItemEventId, type BotItemActor } from '../../../../shared/bots/bot-items'
import {
  BOT_ITEM_MAIL_ID_PREFIX,
  BOT_ITEM_MAIL_SENDER
} from '../../../../shared/bots/bot-item-note-runs'
import { runtimeBotChats } from '../../../bots/bot-chat-session'
import type { BotItemNoteBy } from '../../../../shared/bots/bot-item-note'
import { appendBotItemNote, botItemNote } from '../../../bots/bot-item-chat-notes'
import { botItemChangeMail, botItemMailImages } from '../../../bots/bot-items-mail-text'
import type { BotItemMail } from '../../../bots/bot-items-schema'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { botChatTakingMail } from './bots-chats'

/** A message id from the first item event it carries. */
export function botItemMailId(eventId: number): string {
  return `${BOT_ITEM_MAIL_ID_PREFIX}${botItemEventId(eventId)}`
}

/** Who a mailed change's note names: the owner, the bot's chat that made it ('other-chat' once
 *  that chat is gone), or another agent. */
function noteBy(
  runtime: OrcaRuntimeService,
  bot: Bot,
  actor: BotItemActor | undefined
): BotItemNoteBy {
  if (actor?.kind === 'owner') {
    return 'owner'
  }
  if (actor?.kind !== 'bot') {
    return 'other-chat'
  }
  if (actor.botId !== bot.id) {
    return 'other-agent'
  }
  const items = runtime.botItems
  const source = items.chatSource(bot, actor.chatId, (id) => items.chatRootOf(id), null)
  const chat = items.owningChat({ chatId: actor.chatId, source })
  if (chat.gone) {
    return 'other-chat'
  }
  const home = chat.kind === 'home' ? { home: true as const } : {}
  return { kind: 'chat', chatId: chat.id, title: chat.title, ...home }
}

/** The chat whose conversation's turn asked the question the owner's comment in this write answers. */
function answerAskedIn(owed: BotItemMail): string | null {
  for (const { event } of owed.changes) {
    const asked = event.data.askedInConversation
    if (event.kind === 'commented' && event.actor.kind === 'owner' && typeof asked === 'string') {
      return asked
    }
  }
  return null
}

/** Stores the event's mail unless it is there already; true once nothing is owed. */
export async function sendBotItemMail(
  runtime: OrcaRuntimeService,
  owed: BotItemMail
): Promise<boolean> {
  const db = runtime.getOrchestrationDb()
  const id = botItemMailId(owed.id)
  if (db.getMessageById(id)) {
    return true
  }
  const mail = botItemChangeMail(owed.changes)
  const bot = runtime.bots.list().find((entry) => entry.id === owed.ownerBotId)
  // Changes with nothing to say, or a bot that's gone, owe nothing.
  if (!mail || !bot) {
    return true
  }
  const chat = await botChatTakingMail(runtime, bot, owed.chatId)
  const sessionId = chat?.sessionId ?? (await runtimeBotChats(runtime).ensure(bot.id))
  const to = `orca_session_id:${sessionId}`
  const images = botItemMailImages(owed.changes)
  const asker = answerAskedIn(owed)
  const payload = JSON.stringify({
    botItems: owed.changes.map(({ event, item }) => ({
      uid: item.uid,
      number: item.number,
      eventId: botItemEventId(event.id),
      kind: event.kind
    })),
    // Delivered as the chat's image blocks, as chat sends a pasted image.
    ...(images.length > 0 ? { images } : {}),
    // The owner's answer to a question the item's chat asked while its thread's turn ran; the reader
    // checks it is that chat (conversation-ask-answer.ts).
    ...(asker ? { askedInConversation: asker } : {})
  })
  db.insertMessage({
    id,
    from: BOT_ITEM_MAIL_SENDER,
    to,
    type: 'status',
    ...mail,
    payload,
    orcaAuthored: 'item-mail'
  })
  runtime.notifyMessageArrived(to, 'status')
  // The chat shows the change itself, naming who made it; the mail row stays hidden there. A change
  // made in the chat the mail lands in (Home, when the item's chat takes no mail) has its own row there.
  const by = noteBy(runtime, bot, owed.changes[0]?.event.actor)
  if (typeof by === 'object' && by.chatId === runtime.botItems.chatRootOf(sessionId)) {
    return true
  }
  // A link is named against the item's links; unread, the chat line still shows, PRs as #n.
  const linked = owed.changes.filter(({ event }) => event.kind === 'linked').map(({ item }) => item)
  const read =
    linked.length > 0
      ? await runtime.botItems.views(linked).catch((error: unknown) => {
          console.warn('[bots] items: reading links for a chat note failed', error)
          return []
        })
      : []
  const views = new Map(read.map((view) => [view.uid, view]))
  const changes = owed.changes.map((change) => ({
    ...change,
    links: views.get(change.item.uid)?.links
  }))
  appendBotItemNote(sessionId, botItemNote(`m${owed.id}`, by, changes))
  return true
}
