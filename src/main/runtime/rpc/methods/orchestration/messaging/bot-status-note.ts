// A bot's `send --type status` to another bot or its own other chat wakes no one: where its work
// stands lives on an item, so Orca records it there and the other bot reads it when it needs it.
import { BOT_ITEM_OPEN_STATUSES, BOT_ITEM_STATUSES } from '../../../../../../shared/bots/bot-items'
import { BOT_ITEM_MAIL_ID_PREFIX } from '../../../../../../shared/bots/bot-item-note-runs'
import type { Bot } from '../../../../../../shared/bot-types'
import type { BotItemRecord } from '../../../../../bots/bot-items-schema'
import type { BotItemsRemote } from '../../../../../bots/bot-items-ops'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { ActingSender } from './bot-recipient'

export type BotStatusNoteReceipt = {
  recorded: { item: number; bot: string }
  /** Empty, so an older CLI that knows only sent mail prints this receipt's `next` too. */
  messages: []
  recipients: 0
  next: string
}

type StatusMail = { subject: string; body?: string; item?: string; images?: readonly string[] }

const CANDIDATES_SHOWN = 6

/** A bot's own status send (not an item comment or paired mail, which carry their id) is recorded
 *  instead of sent; null for any other mail. */
export async function statusNoteInstead(
  context: { runtime: OrcaRuntimeService; recordMutationReceipt?: (receipt: unknown) => void },
  mail: { params: StatusMail & { type?: string }; messageId?: string; images?: readonly string[] },
  acting: ActingSender,
  target: Bot
): Promise<{ receipt: BotStatusNoteReceipt; nudge: () => void } | null> {
  const { bot, sessionId } = acting
  if (mail.params.type !== 'status' || mail.messageId !== undefined || !bot || !sessionId) {
    return null
  }
  context.runtime.bots.assertEnabled()
  const receipt = await recordBotStatusNote(
    context.runtime,
    { ...acting, bot, sessionId },
    target,
    {
      ...mail.params,
      images: mail.images
    }
  )
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
    throw new OrchestrationError(
      'invalid_argument',
      'A status is recorded on an item, which takes no files this way. Nothing was sent. Attach them with `orca bot item comment <n> --text "..." --file <path>`.'
    )
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
  if (named !== undefined) {
    const trimmed = named.trim()
    const item = /^\d+$/.test(trimmed) ? await store.byNumber(Number(trimmed)) : undefined
    if (!item) {
      throw new OrchestrationError(
        'not_found',
        `No item ${trimmed} on this computer, so nothing was recorded. \`orca bot item list\` lists yours.`
      )
    }
    return item
  }
  const own = (item: BotItemRecord | null | undefined): item is BotItemRecord =>
    item?.ownerBotId === acting.bot.id
  if (acting.worker) {
    const { items: linked } = await store.list({
      botId: acting.bot.id,
      link: { kind: 'dispatch', ref: acting.worker },
      statuses: BOT_ITEM_STATUSES,
      limit: CANDIDATES_SHOWN
    })
    if (linked.length > 0) {
      return pickOne(linked)
    }
  }
  const woken = itemUidOfRequest(acting.turn.actingOnRequestId)
  const wokenItem = woken ? await store.get(woken) : null
  if (own(wokenItem)) {
    return wokenItem
  }
  const { items } = await store.list({
    botId: acting.bot.id,
    chatIds: [runtime.botItems.chatRootOf(acting.sessionId)],
    statuses: BOT_ITEM_OPEN_STATUSES,
    limit: CANDIDATES_SHOWN
  })
  return pickOne(items)
}

function pickOne(items: readonly BotItemRecord[]): BotItemRecord {
  if (items.length === 1) {
    return items[0]!
  }
  if (items.length === 0) {
    throw new OrchestrationError(
      'invalid_argument',
      'A status is recorded on the item it is about, and this chat has no open item. Nothing was sent. Add or pick an item (`orca bot item add --title "..."`, then `orca bot item comment <n> --text "..."`), or use --type question or --type handoff if the other bot needs to act.'
    )
  }
  const listed = items.map((item) => `${item.number} (${item.title})`).join(', ')
  throw new OrchestrationError(
    'invalid_argument',
    `A status is recorded on the item it is about, and this chat has several open items: ${listed}. Nothing was sent. Comment on the right one: \`orca bot item comment <n> --text "..."\`, or send again with --item <n>.`
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
