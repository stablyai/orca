// What item writes take and give back, and the bounds every write is held to.
import { join } from 'node:path'
import {
  BOT_ITEM_LIMITS,
  type BotItemActor,
  type BotItemLinkKind,
  type BotItemStatus
} from '../../shared/bots/bot-items'
import { BotItemAskSchema, botItemAskText, type BotItemAsk } from '../../shared/bots/bot-item-ask'
import { BotItemError } from './bot-item-error'
import type { BotItemMadeBy, BotItemRecord, BotItemSource } from './bot-items-schema'

/** A bot writing from one of its own chats; the author is always the caller's bot. */
export type BotItemBotActor = Extract<BotItemActor, { kind: 'bot' }>

export type BotItemOwnerActor = Extract<BotItemActor, { kind: 'owner' }>

export type BotItemLinkInput = { kind: BotItemLinkKind; ref: string }

export type BotItemAddInput = {
  ownerBotId: string
  chatId: string
  source: BotItemSource
  /** `--for`/`--chat`: chosen before its request mail, which carries it. */
  uid?: string
  /** Made by another bot, or another chat of this one, through a bot request. */
  madeBy?: BotItemMadeBy
  title: string
  description?: string
  doneMeans?: string
  status: 'planned' | 'working'
  links: BotItemLinkInput[]
}

export type BotItemSetInput = {
  title?: string
  description?: string
  doneMeans?: string
  status?: BotItemStatus
  note?: string
  /** With Canceled, which needs it: the reason. */
  reason?: string
  /** With a status move, written as the agent's comment; with Needs you, the question. With `ask`, only
   *  the readable fallback a host without asks would keep; this host builds its own from the ask. */
  comment?: string
  /** With Needs you: the decisions, their choices and their context. */
  ask?: BotItemAsk
}

/** What a write did. */
export type BotItemWriteOutcome = {
  uid: string
  /** The event it wrote; null when nothing changed. */
  eventId: number | null
  created?: boolean
  unchanged?: boolean
}

const TEXT_LIMITS = {
  title: BOT_ITEM_LIMITS.title,
  description: BOT_ITEM_LIMITS.description,
  doneMeans: BOT_ITEM_LIMITS.doneMeans,
  note: BOT_ITEM_LIMITS.text,
  text: BOT_ITEM_LIMITS.text
} as const

/** Longer text is refused, never cut: details belong in a linked file. */
export function assertBotItemText(
  field: keyof typeof TEXT_LIMITS,
  value: string | undefined
): void {
  const limit = TEXT_LIMITS[field]
  if (value !== undefined && value.length > limit) {
    throw new BotItemError(
      'invalid_argument',
      `${field} is ${value.length} characters; the limit is ${limit}. Put the details in a file and link it.`
    )
  }
}

/** A status move's comment data. A Needs you question is marked `answerable`: this host records answers,
 *  so a recorded answer or the owner's reply closes it, and a later unrelated comment never counts as
 *  its answer. With an ask it holds the
 *  decisions and a host-built `text` spelling them out for readers without the ask; the sent `comment`
 *  (an older host's fallback) is not kept. */
export function botItemCommentData(
  comment: string | undefined,
  ask: BotItemAsk | undefined,
  question: boolean
): { text: string; ask?: BotItemAsk; answerable?: true } {
  const answerable = question ? { answerable: true as const } : {}
  if (!ask) {
    return { text: comment ?? '', ...answerable }
  }
  const parsed = BotItemAskSchema.safeParse(ask)
  if (!parsed.success) {
    throw new BotItemError('invalid_argument', parsed.error.issues[0]?.message ?? 'Invalid --ask.')
  }
  const text = botItemAskText(parsed.data)
  assertBotItemText('text', text)
  return { text, ask: parsed.data, ...answerable }
}

/** Each link once, first spelling kept: what an add checks and then stores. */
export function uniqueBotItemLinks(links: readonly BotItemLinkInput[]): BotItemLinkInput[] {
  const seen = new Set<string>()
  return links.filter((link) => {
    const key = linkWords(link)
    return seen.has(key) ? false : (seen.add(key), true)
  })
}

/** Everything an add checks before it writes, so a request for another chat is refused before it is sent. */
export function assertBotItemAddable(input: {
  title: string
  description?: string
  doneMeans?: string
  links: readonly BotItemLinkInput[]
}): void {
  assertBotItemText('title', input.title)
  assertBotItemText('description', input.description)
  assertBotItemText('doneMeans', input.doneMeans)
  if (!input.title.trim()) {
    throw new BotItemError('invalid_argument', 'An item needs a title.')
  }
  if (input.links.length > BOT_ITEM_LIMITS.links) {
    throw new BotItemError(
      'invalid_argument',
      `An item takes up to ${BOT_ITEM_LIMITS.links} links.`
    )
  }
}

/** The items file, next to bot-work.sqlite in the profile folder. */
export function botItemsStoreFile(userDataPath: string): string {
  return join(userDataPath, 'bot-items.sqlite')
}

/** Any change the item's own chat didn't make mails that chat. */
export function mailsItemChat(item: BotItemRecord, actor: BotItemActor): boolean {
  return actor.kind === 'owner' || (actor.kind === 'bot' && actor.chatId !== item.chatId)
}

export function linkWords(link: BotItemLinkInput): string {
  return `${link.kind}:${link.ref}`
}
