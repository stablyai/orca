// `bots.items.*`: a bot's items over RPC. Reads take `--bot` (whose list) or the calling chat's or
// run's bot; writes live in bots-items-write-methods, the owner's panel in bots-items-owner-methods.
import {
  BOT_ITEM_LIMITS,
  BOT_ITEM_OPEN_STATUSES,
  BOT_ITEM_STATUSES,
  parseBotItemEventId,
  type BotItemStatus
} from '../../../../shared/bots/bot-items'
import { BotItemsList, BotItemsShow } from '../../../../shared/rpc-contract/bots-items-params'
import { BotItemError } from '../../../bots/bot-item-error'
import { defineMethod } from '../core'
import { itemsReader, itemsWriter } from './bots-items-caller'
import { BOT_ITEMS_OWNER_METHODS } from './bots-items-owner-methods'
import { BOT_ITEMS_WRITE_METHODS } from './bots-items-write-methods'
import { pageSize, parseCursor, parseItemLink, resolveItem } from './bots-items-write-support'
import {
  botItemCountsForClient,
  botItemEventsForClient,
  botItemsForClient,
  botItemStatusesForClient
} from './bots-items-waiting-compat'

const LIST = defineMethod({
  name: 'bots.items.list',
  permission: 'workspace',
  params: BotItemsList,
  handler: async (params, context) => {
    const { runtime } = context
    runtime.bots.assertEnabled()
    const bot = itemsReader(params, context)
    const statuses: readonly BotItemStatus[] = params.statuses?.length
      ? botItemStatusesForClient(params.statuses, context)
      : params.all
        ? BOT_ITEM_STATUSES
        : BOT_ITEM_OPEN_STATUSES
    // `--here` is the calling chat, which only a bot's own chat has.
    const chatId = params.here
      ? itemsWriter(params.callerSessionId, context).actor.chatId
      : params.chat?.replace(/^chat:/, '')
    const limit = pageSize(params.limit, BOT_ITEM_LIMITS.listPage, BOT_ITEM_LIMITS.listPageMax)
    const cursor = parseCursor(params.cursor)
    const link = params.link !== undefined ? parseItemLink(params.link) : undefined
    const page = await runtime.botItems.store().list({
      botId: bot.id,
      statuses,
      ...(chatId !== undefined ? { chatIds: [chatId] } : {}),
      ...(link ? { link } : {}),
      limit: limit + 1,
      ...(cursor ? { cursor } : {})
    })
    const rows = page.items.slice(0, limit)
    const last = rows.at(-1)
    const more = page.items.length > limit && last
    return {
      botId: bot.id,
      botName: bot.name,
      items: botItemsForClient(await runtime.botItems.views(rows), context),
      counts: botItemCountsForClient(page.counts, context),
      ...(more ? { nextCursor: `${last.lastActivityAt}:${last.number}` } : {})
    }
  }
})

const SHOW = defineMethod({
  name: 'bots.items.show',
  permission: 'workspace',
  params: BotItemsShow,
  handler: async (params, context) => {
    const { runtime } = context
    runtime.bots.assertEnabled()
    const store = runtime.botItems.store()
    const record = await resolveItem(store, params.item)
    const after = params.after !== undefined ? parseBotItemEventId(params.after) : 0
    if (after === null) {
      throw new BotItemError('invalid_argument', '--after takes an event id such as e41.')
    }
    const limit = pageSize(params.limit, BOT_ITEM_LIMITS.eventsPage, BOT_ITEM_LIMITS.eventsPage)
    const view = await runtime.botItems.showView(record, after, limit + 1)
    const [item] = botItemsForClient([view.item], context)
    const { events } = view
    const page = events.slice(0, limit)
    const last = page.at(-1)
    return {
      item: item!,
      events: botItemEventsForClient(page, context),
      ...(events.length > limit && last ? { nextCursor: last.id } : {})
    }
  }
})

export const BOT_ITEMS_METHODS = [
  ...BOT_ITEMS_WRITE_METHODS,
  ...BOT_ITEMS_OWNER_METHODS,
  LIST,
  SHOW
]
