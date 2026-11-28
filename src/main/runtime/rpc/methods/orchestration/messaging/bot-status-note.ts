// A bot's `send --type status` to another bot or its own other chat wakes no one: where its work
// stands lives on an item, so Orca records it there and the other bot reads it when it needs it.
import {
  BOT_ITEM_OPEN_STATUSES,
  isOpenBotItemStatus
} from '../../../../../../shared/bots/bot-items'
import { isBotGroupMemberSession } from '../../../../../../shared/bots/bot-group'
import type { OrchestrationPartyIdentity } from '../../../../../../shared/orchestration/mailbox/orchestration-party-identity'
import { botRequestRefusal, botNotFound } from '../../../../../bots/bot-request-policy'
import { botOfSession } from '../../../../../bots/bot-session-tabs'
import { BOT_ITEM_MAIL_ID_PREFIX } from '../../../../../../shared/bots/bot-item-note-runs'
import type { Bot } from '../../../../../../shared/bot-types'
import type { BotItemRecord } from '../../../../../bots/bot-items-schema'
import type { BotItemsRemote } from '../../../../../bots/bot-items-ops'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import {
  creatorSession,
  refuse,
  toOtherChat,
  type ActingSender,
  type ReceivingBot
} from './bot-recipient'

export type BotStatusNoteReceipt = {
  recorded: { item: number; bot: string }
  /** Empty, so an older CLI that knows only sent mail prints this receipt's `next` too. */
  messages: []
  recipients: 0
  next: string
}

type StatusMail = { subject: string; body?: string; item?: string; images?: readonly string[] }

const CANDIDATES_SHOWN = 6

const STATUS_FILES_REFUSAL =
  'A status is recorded on an item, which takes no files this way. Nothing was sent. Attach them with `orca bot item comment <n> --text "..." --file <path>`.'

/** Whether a bot's own status send (not an item comment, paired mail or a group room's) is recorded
 *  instead of sent. */
function isRecordedStatus(
  mail: { params: { type?: string }; messageId?: string; to: string },
  sessionId: string | null | undefined
): boolean {
  return (
    mail.params.type === 'status' &&
    mail.messageId === undefined &&
    !mail.to.includes('bot-group-member-') &&
    !isBotGroupMemberSession(sessionId)
  )
}

/** Refused before `--file` attachments are claimed: a recorded status takes none. */
export async function assertNoStatusFiles(
  runtime: OrcaRuntimeService,
  mail: { params: { type?: string; files?: readonly string[] }; messageId?: string; to: string },
  sender: OrchestrationPartyIdentity,
  callerSessionId: string | undefined
): Promise<void> {
  if (!mail.params.files?.length || mail.params.type !== 'status') {
    return
  }
  // Which chat is a bot's is read from the session host, so it is up before the sender is placed.
  await runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
  const creator = creatorSession(runtime.getOrchestrationDb(), sender).sessionId
  const sessionId = creator ?? callerSessionId
  if (!sessionId || !botOfSession(runtime.bots, sessionId) || !isRecordedStatus(mail, sessionId)) {
    return
  }
  throw new OrchestrationError('invalid_argument', STATUS_FILES_REFUSAL)
}

/** A bot's own status send is recorded instead of sent, after the checks any bot request passes;
 *  null for any other mail. */
export async function statusNoteInstead(
  context: { runtime: OrcaRuntimeService; recordMutationReceipt?: (receipt: unknown) => void },
  mail: {
    params: StatusMail & { type?: string }
    messageId?: string
    to: string
    images?: readonly string[]
  },
  acting: ActingSender,
  receiving: ReceivingBot
): Promise<{ receipt: BotStatusNoteReceipt; nudge: () => void } | null> {
  const { runtime } = context
  const { bot, sessionId } = acting
  if (!bot || !sessionId || !isRecordedStatus(mail, sessionId)) {
    return null
  }
  const target = runtime.bots.list().find((entry) => entry.id === receiving.bot.id)
  const refusal = target
    ? botRequestRefusal({
        enabled: runtime.bots.enabled(),
        target,
        senderBotId: bot.id,
        toOtherChat: toOtherChat(receiving, sessionId),
        type: 'status',
        fromWorker: acting.worker !== undefined
      })
    : botNotFound(receiving.bot.name, runtime.bots.list())
  if (refusal || !target) {
    return refuse(refusal ?? botNotFound(receiving.bot.name, runtime.bots.list()))
  }
  const receipt = await recordBotStatusNote(runtime, { ...acting, bot, sessionId }, target, {
    ...mail.params,
    images: mail.images
  })
  context.recordMutationReceipt?.(receipt)
  return { receipt, nudge: () => {} }
}

async function recordBotStatusNote(
  runtime: OrcaRuntimeService,
  acting: ActingSender & { bot: Bot; sessionId: string },
  target: Bot,
  mail: StatusMail
): Promise<BotStatusNoteReceipt> {
  if (mail.images?.length) {
    throw new OrchestrationError('invalid_argument', STATUS_FILES_REFUSAL)
  }
  const store = runtime.botItems.store()
  const item = await statusItem(runtime, store, acting, mail.item)
  const text = `Status from ${acting.bot.name} for ${target.name}: ${mail.subject}${mail.body?.trim() ? `\n\n${mail.body}` : ''}`
  await store.orcaComment(item.uid, text, 'bot-status')
  const owner = runtime.bots.list().find((bot) => bot.id === item.ownerBotId)?.name ?? 'its bot'
  return {
    recorded: { item: item.number, bot: owner },
    messages: [],
    recipients: 0,
    next: `Recorded on item ${item.number} of ${owner}; bots read it with \`orca bot item show ${item.number}\`. Nothing was delivered, so ${target.name} was not woken. To have it act or answer, send --type question or --type handoff.`
  }
}

/** The item the status is about: the one `--item` names, the worker's, the item request that woke
 *  the turn, or the sending chat's one open item. Never a guess between several. */
async function statusItem(
  runtime: OrcaRuntimeService,
  store: BotItemsRemote,
  acting: ActingSender & { bot: Bot; sessionId: string },
  named: string | undefined
): Promise<BotItemRecord> {
  const chatOpen = (limit = CANDIDATES_SHOWN) =>
    store.list({
      botId: acting.bot.id,
      chatIds: [runtime.botItems.chatRootOf(acting.sessionId)],
      statuses: BOT_ITEM_OPEN_STATUSES,
      limit
    })
  if (named !== undefined) {
    const trimmed = named.trim()
    const item = /^\d+$/.test(trimmed) ? await store.byNumber(Number(trimmed)) : undefined
    if (!item) {
      throw new OrchestrationError(
        'not_found',
        `No item ${trimmed} on this computer, so nothing was recorded. \`orca bot item list\` lists yours.`
      )
    }
    if (!isOpenBotItemStatus(item.status)) {
      const open = await chatOpen()
      const others = open.items.length > 0 ? ` Open items in this chat: ${listed(open)}.` : ''
      throw new OrchestrationError(
        'item_closed',
        `Item ${item.number} is closed, so nothing was recorded.${others}`
      )
    }
    return item
  }
  if (acting.worker) {
    const linked = await store.list({
      botId: acting.bot.id,
      link: { kind: 'dispatch', ref: acting.worker },
      statuses: BOT_ITEM_OPEN_STATUSES,
      limit: CANDIDATES_SHOWN
    })
    if (linked.items.length > 0) {
      return pickOne(linked)
    }
  }
  const woken = itemUidOfRequest(acting.turn.actingOnRequestId)
  const wokenItem = woken ? await store.get(woken) : null
  if (wokenItem?.ownerBotId === acting.bot.id && isOpenBotItemStatus(wokenItem.status)) {
    return wokenItem
  }
  return pickOne(await chatOpen())
}

type OpenItems = Awaited<ReturnType<BotItemsRemote['list']>>

/** The open items a read found, and how many there are when the read was cut off. */
function listed({ items, counts }: OpenItems): string {
  const total = BOT_ITEM_OPEN_STATUSES.reduce((sum, status) => sum + (counts[status] ?? 0), 0)
  const names = items.map((item) => `${item.number} (${item.title})`).join(', ')
  return total > items.length ? `${names} (showing ${items.length} of ${total})` : names
}

function pickOne(open: OpenItems): BotItemRecord {
  const { items } = open
  if (items.length === 1) {
    return items[0]!
  }
  if (items.length === 0) {
    throw new OrchestrationError(
      'invalid_argument',
      'No open item to record this status on, so nothing was sent. If the other bot needs to act, use --type question or --type handoff; otherwise there is nothing to send.'
    )
  }
  throw new OrchestrationError(
    'invalid_argument',
    `A status is recorded on the item it is about, and this chat has several open items: ${listed(open)}. Nothing was sent. Comment on the right one: \`orca bot item comment <n> --text "..."\`.`
  )
}

/** `bot item add --for` mail is `msg_item_` and the item's uid without its dashes. */
function itemUidOfRequest(messageId: string | null): string | null {
  const hex = messageId?.startsWith(BOT_ITEM_MAIL_ID_PREFIX)
    ? messageId.slice(BOT_ITEM_MAIL_ID_PREFIX.length)
    : ''
  return /^[0-9a-f]{32}$/.test(hex)
    ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    : null
}
