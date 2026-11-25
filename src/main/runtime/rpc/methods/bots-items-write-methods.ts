// `bots.items.*` writes: only from a bot's own chat on this host, authored by that bot.
import {
  BotItemsAdd,
  BotItemsCancel,
  BotItemsComment,
  BotItemsDone,
  BotItemsLink,
  BotItemsSet
} from '../../../../shared/rpc-contract/bots-items-params'

import { botItemAskAdvice } from '../../../../shared/bots/bot-item-ask-advice'
import {
  dispatchStarterBotId,
  linksOutsideLinkedChains
} from '../../../bots/bot-item-dispatch-facts'
import { defineMethod } from '../core'
import { addItem } from './bots-items-add'
import { admitBotItemFiles } from './bots-items-bot-files'
import { BotItemError } from '../../../bots/bot-item-error'
import { assertBotItemSetInput } from '../../../bots/bot-items-edits'
import { assertBotItemAttach, assertBotItemOwnerWrite } from '../../../bots/bot-items-tables'
import type { BotItemLinkInput } from '../../../bots/bot-items-input'
import type { OrchestrationDb } from '../../orchestration/db/orchestration-db'
import type { Bot } from '../../../../shared/bot-types'
import { commentAsMaker } from './bots-items-maker-comment'
import { runtimeChatHost } from '../../../external-conversations/external-conversation-chat'
import { closingChatActsFor } from './bots-items-close-acts-for'
import { parseItemLink, resolveItem, writeResult, writerOf } from './bots-items-write-support'

const ADD = defineMethod({
  name: 'bots.items.add',
  permission: 'workspace',
  share: 'not-shared',
  params: BotItemsAdd,
  handler: addItem
})

const SET = defineMethod({
  name: 'bots.items.set',
  permission: 'workspace',
  share: 'not-shared',
  params: BotItemsSet,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    const { title, description, doneMeans, status, note, reason } = params
    let { comment, ask } = params
    if (params.files?.length && !comment?.trim() && !ask) {
      throw new BotItemError('invalid_argument', '--file goes with --comment. Nothing was posted.')
    }
    if (params.files?.length) {
      // What the write would refuse anyway is refused before any file is copied and claimed.
      assertBotItemSetInput({ title, description, doneMeans, status, note, reason, comment, ask })
      assertBotItemOwnerWrite(item, writer.actor, status)
    }
    // With an ask, the files go under its own context; its comment is the host's rendering of it.
    const words = ask ? (ask.context ?? '') : (comment ?? '')
    const attached = await admitBotItemFiles(context, item, words, params.files)
    if (ask && params.files?.length) {
      ask = { ...ask, ...(attached.text ? { context: attached.text } : {}) }
    } else if (!ask && comment !== undefined) {
      comment = attached.text
    }
    const images = attached.images.length > 0 ? attached.images : undefined
    // Asked by the item's own thread chat while its thread's turn ran, the owner's answer, mailed to
    // that chat, goes back to that thread. Home Chat, which the bot's direct messages share with its
    // owner in Orca, keeps it in Orca, as does an ask about another chat's item.
    const asked =
      ask &&
      writer.source.kind === 'thread' &&
      writer.actor.chatId === item.chatId &&
      context.runtime
        .getExternalConversationSeam()
        ?.conversationTurn(runtimeChatHost(context.runtime), writer.sessionId)
        ? { askedInConversation: writer.sessionId }
        : {}
    const closing = status === 'done' || status === 'canceled'
    const changes = {
      ...(closing ? { closedFor: await closingChatActsFor(context, writer) } : {}),
      title,
      description,
      doneMeans,
      status,
      note,
      reason,
      comment,
      ask,
      images,
      ...asked
    }
    const defined = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined)
    )
    const outcome = await store.set(item.uid, defined, writer.actor)
    const result = await writeResult(context, outcome, writer)
    // A tip back to the bot when its ask may be hard to read; the ask is already posted as written.
    const advice =
      status === 'needs_you' && result.eventId !== null ? botItemAskAdvice({ comment, ask }) : null
    return advice ? { ...result, advice } : result
  }
})

const COMMENT = defineMethod({
  name: 'bots.items.comment',
  permission: 'workspace',
  share: 'not-shared',
  params: BotItemsComment,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    if (params.files?.length && ![item.ownerBotId, item.madeBy?.botId].includes(writer.bot.id)) {
      assertBotItemOwnerWrite(item, writer.actor)
    }
    const { text, images } = await admitBotItemFiles(context, item, params.text, params.files)
    const outcome =
      item.ownerBotId !== writer.bot.id && item.madeBy?.botId === writer.bot.id
        ? await commentAsMaker(context, writer, item, text, images)
        : await store.comment(item.uid, text, writer.actor, images)
    return writeResult(context, outcome, writer)
  }
})

const DONE = defineMethod({
  name: 'bots.items.done',
  permission: 'workspace',
  share: 'not-shared',
  params: BotItemsDone,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    const actsFor = await closingChatActsFor(context, writer)
    const outcome = await store.close(item.uid, 'done', params.note, writer.actor, actsFor)
    return writeResult(context, outcome, writer)
  }
})

const CANCEL = defineMethod({
  name: 'bots.items.cancel',
  permission: 'workspace',
  share: 'not-shared',
  params: BotItemsCancel,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    const actsFor = await closingChatActsFor(context, writer)
    const outcome = await store.close(item.uid, 'canceled', params.reason, writer.actor, actsFor)
    return writeResult(context, outcome, writer)
  }
})

const LINK = defineMethod({
  name: 'bots.items.link',
  permission: 'workspace',
  share: 'not-shared',
  params: BotItemsLink,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    const db = context.runtime.getOrchestrationDb()
    const requested = params.refs.map(parseItemLink)
    const startedBy: Record<string, string | null> =
      item.ownerBotId === writer.bot.id
        ? {}
        : startersOf(db, requested, context.runtime.bots.list())
    // Every worker named is checked, one already linked too, so a mixed call fails whole.
    assertBotItemAttach(item, writer.actor, requested, (id) => startedBy[id] ?? null)
    if (params.check) {
      return null
    }
    // A step of a follow-up chain the item already links is that worker again: no second link.
    const links = linksOutsideLinkedChains(db, await store.links(item.uid), requested)
    const outcome = await store.link(item.uid, links, writer.actor, startedBy)
    return writeResult(context, outcome, writer)
  }
})

/** Who started each worker named, read only for a link to someone else's item. */
function startersOf(
  db: OrchestrationDb,
  links: readonly BotItemLinkInput[],
  bots: readonly Bot[]
): Record<string, string | null> {
  return Object.fromEntries(
    links.flatMap((link) =>
      link.kind === 'dispatch' ? [[link.ref, dispatchStarterBotId(db, link.ref, bots)]] : []
    )
  )
}

export const BOT_ITEMS_WRITE_METHODS = [ADD, SET, COMMENT, DONE, CANCEL, LINK]
