// What every `bots.items.*` write shares: the item a number names, its links as typed refs, and the
// item it answers with.
import { botOfAddress, parseBotAddress } from '../../../../shared/bot-roster'
import type { Bot } from '../../../../shared/bot-types'
import {
  botItemEventId,
  botItemPrRefOfUrl,
  parseBotItemPrRef,
  type BotItem
} from '../../../../shared/bots/bot-items'
import type { BotItemAskAdvice } from '../../../../shared/bots/bot-item-ask-advice'
import { botNotFound } from '../../../bots/bot-request-policy'
import { BotItemError } from '../../../bots/bot-item-error'
import type { BotItemLinkInput, BotItemWriteOutcome } from '../../../bots/bot-items-input'
import type { BotItemsRemote } from '../../../bots/bot-items-ops'
import type { BotItemRecord } from '../../../bots/bot-items-schema'
import { noteBotItemWrite } from '../../../bots/bot-item-chat-notes'
import { notifyBotItemQuestion } from '../../../bots/bot-item-question-notice'
import { runtimeBotOwnerNotice } from '../../../bots/bot-could-not-finish'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import type { RpcContext } from '../core'
import { itemsWriter, type BotItemWriter } from './bots-items-caller'
import { botItemsForClient } from './bots-items-waiting-compat'

export type BotItemWriteResult = {
  item: BotItem
  eventId: string | null
  created?: boolean
  unchanged?: boolean
  /** A Needs you ask that may be hard to read: why, and one tip for the bot. */
  advice?: BotItemAskAdvice
}

/** Stops a write when the caller is not a bot chat, before any store work. The writer is the session
 *  the host verified; a different `callerSessionId` is refused. */
export function writerOf(params: { callerSessionId?: string }, context: RpcContext): BotItemWriter {
  context.runtime.bots.assertEnabled()
  const sessionId = sessionCallerOf(context.orchestrationCaller)?.sessionId ?? undefined
  if (
    !sessionId ||
    (params.callerSessionId !== undefined && params.callerSessionId !== sessionId)
  ) {
    throw new BotItemError(
      'invalid_argument',
      "Only a bot writes items, from one of its own chats. Run this from the bot's chat."
    )
  }
  return itemsWriter(sessionId, context)
}

/** The item a number (as the CLI shows it) or uid names on this host. */
export async function resolveItem(store: BotItemsRemote, ref: string): Promise<BotItemRecord> {
  const trimmed = ref.trim()
  const item = /^\d+$/.test(trimmed)
    ? await store.byNumber(Number(trimmed))
    : await store.get(trimmed)
  if (!item) {
    throw new BotItemError(
      'not_found',
      /^\d+$/.test(trimmed)
        ? `No item ${trimmed} on this computer. \`orca bot item list --all\` lists them.`
        : `Item ${trimmed} was never made: a request named it, but making it failed. If it is still wanted, add it with \`orca bot item add\`.`
    )
  }
  return item
}

/** What a write answers with: the item as it is now, and what the write did. The writer's chat shows
 *  the write as an item note; a write that asks the owner tells them. */
export async function writeResult(
  context: Pick<RpcContext, 'runtime' | 'clientKind' | 'clientCapabilities'>,
  outcome: BotItemWriteOutcome,
  writer: BotItemWriter
): Promise<BotItemWriteResult> {
  const { runtime } = context
  const store = runtime.botItems.store()
  const record = await store.get(outcome.uid)
  if (!record) {
    throw new BotItemError('not_found', 'The item is gone.')
  }
  runtime.botItems.changed([record])
  const [view] = await runtime.botItems.views([record])
  const [item] = botItemsForClient([view!], context)
  if (outcome.eventId !== null) {
    const write = await noteBotItemWrite(
      store,
      writer.sessionId,
      record,
      outcome.eventId,
      item!.links
    )
    const owner = runtime.bots.list().find((bot) => bot.id === record.ownerBotId)
    notifyBotItemQuestion(runtimeBotOwnerNotice(runtime), owner, item!, write)
  }
  // A write from another chat of the bot owes the item's chat a mail.
  await runtime.botItems.sendOwedMail()
  const { uid: _uid, eventId, ...rest } = outcome
  return { item: item!, eventId: eventId === null ? null : botItemEventId(eventId), ...rest }
}

/** A bot named the way mail names it, or `me`: the caller's own bot. */
export function botNamed(value: string, writer: Bot, bots: readonly Bot[]): Bot {
  const name = parseBotAddress(value) ?? value
  const bot = name.toLowerCase() === 'me' ? writer : botOfAddress(bots, name)
  if (!bot) {
    throw new BotItemError('invalid_argument', botNotFound(name, bots).message)
  }
  return bot
}

/** `dispatch:<id>`, `automation:<id>`, `pr:<owner/repo#n>`, a URL (a GitHub PR URL is that PR), or a
 *  path. One form per thing, so `item list --link` finds it however it was written. */
export function parseItemLink(ref: string): BotItemLinkInput {
  const value = ref.trim()
  const [scheme = '', ...rest] = value.split(':')
  const body = rest.join(':')
  if ((scheme === 'dispatch' || scheme === 'automation') && body) {
    return { kind: scheme, ref: body }
  }
  if (scheme === 'pr') {
    if (!parseBotItemPrRef(body)) {
      throw new BotItemError('invalid_argument', `${value}: a PR link is pr:<owner/repo#number>.`)
    }
    return { kind: 'pr', ref: body.trim() }
  }
  if (/^https?:\/\//i.test(value)) {
    const pr = botItemPrRefOfUrl(value)
    return pr ? { kind: 'pr', ref: pr } : { kind: 'url', ref: value }
  }
  if (!value) {
    throw new BotItemError('invalid_argument', 'An empty link.')
  }
  return { kind: 'file', ref: scheme === 'file' && body ? body : value }
}

/** A list cursor as a list printed it. */
export function parseCursor(
  cursor: string | undefined
): { at: number; number: number } | undefined {
  const match = cursor ? /^(\d+):(\d+)$/.exec(cursor) : null
  if (cursor && !match) {
    throw new BotItemError('invalid_argument', 'That --cursor is not one this list printed.')
  }
  return match ? { at: Number(match[1]), number: Number(match[2]) } : undefined
}

export function pageSize(limit: number | undefined, fallback: number, max: number): number {
  return Math.min(Math.max(1, Math.floor(limit ?? fallback)), max)
}
