// A comment from the bot that made an item for another bot with `--for`: sent to the item's chat as
// that bot's request, like the `--for` that made it, so the chain and whom the turn acts for travel
// with it. Written once the request is stored and before that chat is woken.
import { randomUUID } from 'node:crypto'
import { BotItemError } from '../../../bots/bot-item-error'
import { assertBotItemText, type BotItemWriteOutcome } from '../../../bots/bot-items-input'
import { botItemMakerCommentMail } from '../../../bots/bot-items-mail-text'
import type { BotItemRecord } from '../../../bots/bot-items-schema'
import type { RpcContext } from '../core'
import { sendItemRequest } from './bots-items-add'
import type { BotItemWriter } from './bots-items-caller'
import { botChatTakingMail } from './bots-chats'

export async function commentAsMaker(
  context: RpcContext,
  writer: BotItemWriter,
  item: BotItemRecord,
  text: string
): Promise<BotItemWriteOutcome> {
  const { runtime } = context
  // Checked before the request goes, so a comment the store refuses is never sent.
  assertBotItemText('text', text)
  if (!text.trim()) {
    throw new BotItemError('invalid_argument', 'A comment needs its text.')
  }
  const target = runtime.bots.list().find((bot) => bot.id === item.ownerBotId)
  const chat = target ? await botChatTakingMail(runtime, target, item.chatId) : null
  if (!target || !chat) {
    // Never another chat: the comment is about this one's work.
    throw new BotItemError(
      'item_closed',
      `The chat item ${item.number} is in was closed, so nothing was sent. Ask ${target?.name ?? 'its bot'} with \`orca orchestration send --to bot:<name>\` instead.`
    )
  }
  const sent = await sendItemRequest(context, {
    type: 'status',
    to: `orca_session_id:${chat.sessionId}`,
    messageId: `msg_item_${randomUUID().replaceAll('-', '')}`,
    keepChat: true,
    ...botItemMakerCommentMail(item, writer.bot.name, text)
  })
  try {
    return await runtime.botItems.store().comment(item.uid, text, writer.actor)
  } finally {
    sent.nudge()
  }
}
