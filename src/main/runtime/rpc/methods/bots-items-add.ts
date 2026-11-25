// `bots.items.add`: an item in the caller's chat, or (`--for`, `--chat`) for another bot or another of
// its own chats. The second goes as ordinary bot request mail from the calling chat; the item is made
// in the chat the request landed in, right after it is stored and before that chat is woken. A crash
// between the two leaves mail naming an item never made.
import { randomUUID } from 'node:crypto'
import type { BotItemsAddParams } from '../../../../shared/rpc-contract/bots-items-params'
import { BotItemError } from '../../../bots/bot-item-error'
import { BOT_ITEM_LIMITS, type BotItemOrigin } from '../../../../shared/bots/bot-items'
import { botItemRequestMail } from '../../../bots/bot-items-mail-text'
import {
  assertBotItemAddable,
  uniqueBotItemLinks,
  type BotItemLinkInput
} from '../../../bots/bot-items-input'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import type { RpcContext } from '../core'
import { readBotTurnOrigin } from './orchestration/messaging/bot-turn-origin'
import { readBotTurn } from './orchestration/messaging/bot-recipient'
import {
  botRequestOrigin,
  botTurnRequestOrigin,
  UNKNOWN_REQUEST_START
} from './orchestration/messaging/bot-request-chain'
import { botChatAddress } from './orchestration/messaging/bot-chat-address'
import { sendToBot } from './orchestration/messaging/bot-request-send'
import type { BotItemsRemote } from '../../../bots/bot-items-ops'
import {
  botNamed,
  parseItemLink,
  resolveItem,
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
  const typed = (params.links ?? []).map(parseItemLink)
  const from = params.fromItem ? await fromItemOf(store, params.fromItem, writer.bot.id) : null
  const startedIn = await originUrl(context, writer.sessionId)
  const links = uniqueBotItemLinks(startedIn ? withOrigin(typed, startedIn) : typed)
  const target = params.forBot
    ? botNamed(params.forBot, writer.bot, runtime.bots.list())
    : writer.bot
  const fields = {
    title: params.title,
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(params.doneMeans !== undefined ? { doneMeans: params.doneMeans } : {}),
    status: params.status ?? 'planned',
    links,
    ...(startedIn ? { startedIn } : {}),
    ...(from ? { fromItem: { uid: from.uid } } : {})
  }
  if (target.id === writer.bot.id && params.chat === undefined) {
    const origin = await turnRequestOrigin(context, writer.sessionId, from?.rootKey)
    const outcome = await store.add(
      {
        ...fields,
        ...(origin ? { origin } : {}),
        ownerBotId: writer.bot.id,
        chatId: writer.actor.chatId,
        source: writer.source
      },
      writer.actor
    )
    return writeResult(context, outcome, writer)
  }
  assertBotItemAddable(fields)
  const uid = randomUUID()
  const messageId = `msg_item_${uid.replaceAll('-', '')}`
  const sent = await sendItemRequest(context, {
    type: 'handoff',
    to: params.chat
      ? await botChatAddress(runtime, `bot:${target.name}`, params.chat)
      : `bot:${target.name}`,
    messageId,
    ...botItemRequestMail({ uid, ...fields, doneMeans: params.doneMeans ?? null }),
    ...(from?.rootKey ? { fromItemKey: from.rootKey } : {})
  })
  try {
    const chatId = runtime.botItems.chatRootOf(sent.landed)
    const title = runtime.botItems.chatTitleOf(chatId)
    // The request its mail recorded, which the receiving bot's own items and requests carry on.
    const origin = botRequestOrigin(runtime.getOrchestrationDb(), messageId)
    const outcome = await store.add(
      {
        ...fields,
        ...(origin ? { origin } : {}),
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
    return await writeResult(context, outcome, writer)
  } finally {
    sent.nudge()
  }
}

/** The thread, issue or pull request the calling turn's work started in, so its result goes back
 *  there; none when the turn can't be read, which never stops the add. */
async function originUrl(context: RpcContext, sessionId: string): Promise<string | null> {
  try {
    const origin = await readBotTurnOrigin(
      context.runtime,
      context.runtime.getOrchestrationDb(),
      sessionId
    )
    return origin?.url ?? null
  } catch (error) {
    // A newest turn only the whole conversation's sends could place: no origin, as designed.
    if (!(error instanceof Error && error.name === 'JournalWindowNotIndexed')) {
      console.warn('[bots] could not read where an item started', error)
    }
    return null
  }
}

/** The request the calling turn acts on, read as a send from it reads it, so the item shares that
 *  send's chain. A turn that can't be read never stops the add: the item keeps `--from-item`'s key
 *  with an unknown start, or records none. */
async function turnRequestOrigin(
  context: RpcContext,
  sessionId: string,
  fromItemKey: string | undefined
): Promise<BotItemOrigin | null> {
  try {
    const db = context.runtime.getOrchestrationDb()
    const { turn } = await readBotTurn(context.runtime, db, sessionId)
    return botTurnRequestOrigin(db, sessionId, turn, { fromItemKey })
  } catch (error) {
    console.warn('[bots] could not read the request an item came from', error)
    return fromItemKey ? { rootKey: fromItemKey, ...UNKNOWN_REQUEST_START } : null
  }
}

/** `--from-item`: one of the calling bot's own items, and the request it was made for (none for one
 *  made before Orca recorded it). Another bot's item is refused, so no bot files its work under a
 *  request it never served. */
export async function fromItemOf(
  store: Pick<BotItemsRemote, 'byNumber' | 'get' | 'originsOf'>,
  ref: string,
  botId: string
): Promise<{ uid: string; rootKey?: string }> {
  const item = await resolveItem(store, ref)
  if (item.ownerBotId !== botId) {
    throw new BotItemError('invalid_argument', '--from-item names one of your own items.')
  }
  const rootKey = (await store.originsOf([item.uid]))[item.uid]?.rootKey
  return rootKey ? { uid: item.uid, rootKey } : { uid: item.uid }
}

/** The typed links plus the origin's, unless one names the same page (a Slack link may add
 *  `?thread_ts=`). */
function withOrigin(typed: BotItemLinkInput[], url: string): BotItemLinkInput[] {
  const origin = parseItemLink(url)
  const key = (link: BotItemLinkInput) =>
    `${link.kind}:${link.kind === 'url' ? link.ref.split(/[?#]/)[0] : link.ref}`
  // An add already at the link limit keeps its own links: the origin is guidance, never a refusal.
  const full = typed.length >= BOT_ITEM_LIMITS.links
  return full || typed.some((link) => key(link) === key(origin)) ? typed : [...typed, origin]
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
    /** `--from-item`: the request the mail joins in place of its turn's. */
    fromItemKey?: string
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
      ...(mail.fromItemKey ? { fromItemKey: mail.fromItemKey } : {})
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
