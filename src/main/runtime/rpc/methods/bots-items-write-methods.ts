// `bots.items.*` writes: only from a bot's own chat on this host, authored by that bot.
import {
  BotItemsAdd,
  BotItemsCancel,
  BotItemsComment,
  BotItemsDone,
  BotItemsLink,
  BotItemsSet
} from '../../../../shared/rpc-contract/bots-items-params'

import { linksOutsideLinkedChains } from '../../../bots/bot-item-dispatch-facts'
import { defineMethod } from '../core'
import { addItem } from './bots-items-add'
import { commentAsMaker } from './bots-items-maker-comment'
import { parseItemLink, resolveItem, writeResult, writerOf } from './bots-items-write-support'

const ADD = defineMethod({
  name: 'bots.items.add',
  permission: 'workspace',
  params: BotItemsAdd,
  handler: addItem
})

const SET = defineMethod({
  name: 'bots.items.set',
  permission: 'workspace',
  params: BotItemsSet,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    const { title, description, doneMeans, status, note, reason, comment, ask } = params
    const changes = { title, description, doneMeans, status, note, reason, comment, ask }
    const defined = Object.fromEntries(
      Object.entries(changes).filter(([, value]) => value !== undefined)
    )
    const outcome = await store.set(item.uid, defined, writer.actor)
    return writeResult(context.runtime, outcome, writer)
  }
})

const COMMENT = defineMethod({
  name: 'bots.items.comment',
  permission: 'workspace',
  params: BotItemsComment,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    const outcome =
      item.ownerBotId !== writer.bot.id && item.madeBy?.botId === writer.bot.id
        ? await commentAsMaker(context, writer, item, params.text)
        : await store.comment(item.uid, params.text, writer.actor)
    return writeResult(context.runtime, outcome, writer)
  }
})

const DONE = defineMethod({
  name: 'bots.items.done',
  permission: 'workspace',
  params: BotItemsDone,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    const outcome = await store.close(item.uid, 'done', params.note, writer.actor)
    return writeResult(context.runtime, outcome, writer)
  }
})

const CANCEL = defineMethod({
  name: 'bots.items.cancel',
  permission: 'workspace',
  params: BotItemsCancel,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    const outcome = await store.close(item.uid, 'canceled', params.reason, writer.actor)
    return writeResult(context.runtime, outcome, writer)
  }
})

const LINK = defineMethod({
  name: 'bots.items.link',
  permission: 'workspace',
  params: BotItemsLink,
  handler: async (params, context) => {
    const writer = writerOf(params, context)
    const store = context.runtime.botItems.store()
    const item = await resolveItem(store, params.item)
    // A step of a follow-up chain the item already links is that worker again: no second link.
    const links = linksOutsideLinkedChains(
      context.runtime.getOrchestrationDb(),
      await store.links(item.uid),
      params.refs.map(parseItemLink)
    )
    const outcome = await store.link(item.uid, links, writer.actor)
    return writeResult(context.runtime, outcome, writer)
  }
})

export const BOT_ITEMS_WRITE_METHODS = [ADD, SET, COMMENT, DONE, CANCEL, LINK]
