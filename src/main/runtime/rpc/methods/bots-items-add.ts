// `bots.items.add`: an item in the caller's chat, or (`--for`, `--chat`) for another bot or another of
// its own chats. The second goes as ordinary bot request mail from the calling chat; the item is made
// in the chat the request landed in (a teammate's request opens its own conversation), right after it
// is stored and before that chat is woken. A crash between the two leaves mail naming an item never made.
import { randomUUID } from 'node:crypto'
import type { BotItemsAddParams } from '../../../../shared/rpc-contract/bots-items-params'
import { BotItemError } from '../../../bots/bot-item-error'
import { botItemRequestMail } from '../../../bots/bot-items-mail-text'
import { assertBotItemAddable, uniqueBotItemLinks } from '../../../bots/bot-items-input'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import type { RpcContext } from '../core'
import { botChatAddress } from './orchestration/messaging/bot-chat-address'
import { sendToBot } from './orchestration/messaging/bot-request-send'
import {
  botNamed,
  parseItemLink,
  writeResult,
  writerOf,
  type BotItemWriteResult
} from './bots-items-write-support'

export async function addItem(
  params: BotItemsAddParams,
  context: RpcContext
): Promise<BotItemWriteResult> {
  const { runtime } = context
  const writer = writerOf(params, context)
  const store = runtime.botItems.store()
  const links = uniqueBotItemLinks((params.links ?? []).map(parseItemLink))
  const target = params.forBot
    ? botNamed(params.forBot, writer.bot, runtime.bots.list())
    : writer.bot
  const fields = {
    title: params.title,
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.doneMeans !== undefined ? { doneMeans: params.doneMeans } : {}),
    status: params.status ?? 'planned',
    links
  }
  if (target.id === writer.bot.id && params.chat === undefined) {
    const outcome = await store.add(
      { ...fields, ownerBotId: writer.bot.id, chatId: writer.actor.chatId, source: writer.source },
      writer.actor
    )
    return writeResult(runtime, outcome, writer)
  }
  assertBotItemAddable(fields)
  const uid = randomUUID()
  const sent = await sendItemRequest(context, {
    type: 'handoff',
    to: params.chat
      ? await botChatAddress(runtime, `bot:${target.name}`, params.chat)
      : `bot:${target.name}`,
    messageId: `msg_item_${uid.replaceAll('-', '')}`,
    ...botItemRequestMail({ uid, ...fields, doneMeans: params.doneMeans ?? null })
  })
  try {
    const chatId = runtime.botItems.chatRootOf(sent.landed)
    const title = runtime.botItems.chatTitleOf(chatId)
    const outcome = await store.add(
      {
        ...fields,
        uid,
        ownerBotId: target.id,
        chatId,
        source: runtime.botItems.chatSource(
          target,
          chatId,
          (id) => runtime.botItems.chatRootOf(id),
          title
        ),
        madeBy: { botId: writer.bot.id, chatId: writer.actor.chatId }
      },
      writer.actor
    )
    return await writeResult(runtime, outcome, writer)
  } finally {
    sent.nudge()
  }
}

/** Sends as the verified calling chat, through the path `orchestration send --to bot:` takes, so the
 *  mail carries whom the turn acts for and its chain; resolves the session the request landed in. Its
 *  recipient wakes on `nudge`. */
export async function sendItemRequest(
  context: RpcContext,
  mail: {
    type: 'handoff' | 'status'
    to: string
    messageId: string
    subject: string
    body: string
    keepChat?: boolean
  }
): Promise<{ landed: string; nudge: () => void }> {
  const { runtime } = context
  const db = runtime.getOrchestrationDb()
  const caller = sessionCallerOf(context.orchestrationCaller)
  if (!caller) {
    throw new BotItemError('invalid_argument', "Run this from the bot's chat.")
  }
  const sent = await sendToBot(
    { runtime, orchestrationCaller: caller, recordMutationReceipt: undefined },
    {
      params: { subject: mail.subject, body: mail.body, type: mail.type },
      from: caller.address,
      to: mail.to,
      sender: caller,
      routing: { run: undefined },
      messageId: mail.messageId,
      holdNudge: true,
      ...(mail.keepChat ? { keepChat: true } : {})
    }
  )
  const message = sent ? db.getMessageById(mail.messageId) : undefined
  if (!sent) {
    throw new BotItemError('invalid_argument', `${mail.to} reaches no bot on this computer.`)
  }
  if (!message) {
    // A blocked admission answers with another send's receipt and stores nothing of this one.
    throw new BotItemError(
      'invalid_argument',
      'That bot already has this request, so nothing was written.'
    )
  }
  const prefix = 'orca_session_id:'
  return {
    landed: message.to_handle.startsWith(prefix)
      ? message.to_handle.slice(prefix.length)
      : message.to_handle,
    nudge: sent.nudge
  }
}
