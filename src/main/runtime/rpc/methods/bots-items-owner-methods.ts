// `bots.items.owner.*`: the owner's panel, on the desktop or a paired phone; an agent's CLI is refused.
// Every comment and status change mails the item's chat, one mail per action and chat; a snooze mails none.
import {
  BOT_ITEM_LIMITS,
  BOT_ITEM_STATUSES,
  botItemEventId,
  parseBotItemEventId
} from '../../../../shared/bots/bot-items'
import {
  BotItemsOwnerList,
  BotItemsOwnerOpened,
  BotItemsOwnerShow,
  BotItemsOwnerSnooze,
  BotItemsOwnerStatus
} from '../../../../shared/rpc-contract/bots-items-params'
import { BotItemError } from '../../../bots/bot-item-error'
import { defineMethod } from '../core'
import { BOT_ITEM_OWNER_COMMENT_METHOD } from './bots-items-owner-comment'
import { SHARE_BY_BOT } from '../../../../shared/bots/bot-share-rpc-methods'
import {
  assertItemsOfBot,
  itemsSeenOf,
  itemsViewerOf,
  markItemsSeen,
  ownerActor
} from './bots-items-owner-person'
import { botItemListScope, botItemsOfPeople } from '../../../bots/bot-item-access'
import { parseCursor, resolveItem } from './bots-items-write-support'
import { itemsAccess } from './bots-items-caller'
import { allOpenItems, ownerViews } from './bots-items-owner-reads'
import {
  botItemCountsForClient,
  botItemEventsForClient,
  botItemsForClient
} from './bots-items-waiting-compat'

const LIST = defineMethod({
  name: 'bots.items.owner.list',
  permission: 'workspace',
  share: SHARE_BY_BOT,
  params: BotItemsOwnerList,
  handler: async (params, context) => {
    ownerActor(context)
    const { botItems } = context.runtime
    const store = botItems.store()
    // An older client names one chat; a group's panel names its rooms' member sessions.
    const chatIds = params.chatIds ?? (params.chatId !== undefined ? [params.chatId] : undefined)
    // A picked person's items, else the caller's default (a teammate's own) or everyone's when asked:
    // the same scope the items commands list.
    const scope =
      params.person === undefined
        ? botItemListScope(itemsAccess(context), params.everyone === true)
        : botItemListScope(botItemsOfPeople(params.person === null ? null : [params.person]))
    const chat = { ...(chatIds ? { chatIds } : {}), ...scope }
    // Read after the rows, so a mark another device moved meanwhile is the one sent.
    const seenEventId = (): string =>
      botItemEventId(
        itemsSeenOf(
          context,
          context.runtime.bots.list().find((bot) => bot.id === params.botId)
        )
      )
    if (params.uids) {
      // What a notice named: those items (an absent one is deleted or out of scope), with the counts.
      const named = await store.list({
        botId: params.botId,
        ...chat,
        statuses: BOT_ITEM_STATUSES,
        uids: params.uids,
        limit: params.uids.length
      })
      return {
        items: botItemsForClient(
          await ownerViews(context, params.botId, named.items, params.summary),
          context
        ),
        counts: botItemCountsForClient(named.counts, context),
        seenEventId: seenEventId()
      }
    }
    // Every open item, then closed ones a page at a time; a Closed page asked alone skips the open.
    const closedCursor = parseCursor(params.closedCursor)
    const open =
      closedCursor && params.closedOnly ? [] : await allOpenItems(store, params.botId, chat)
    const pageSize = params.closedLimit ?? BOT_ITEM_LIMITS.listPage
    const closed = await store.list({
      botId: params.botId,
      ...chat,
      statuses: ['done', 'canceled'],
      limit: pageSize + 1,
      ...(closedCursor ? { cursor: closedCursor } : {})
    })
    const closedRows = closed.items.slice(0, pageSize)
    const lastClosed = closedRows.at(-1)
    // An item closed between the two reads is in both: once, as Closed.
    const closedUids = new Set(closedRows.map((item) => item.uid))
    const stillOpen = open.filter((item) => !closedUids.has(item.uid))
    return {
      items: botItemsForClient(
        await ownerViews(context, params.botId, [...stillOpen, ...closedRows], params.summary),
        context
      ),
      counts: botItemCountsForClient(closed.counts, context),
      seenEventId: seenEventId(),
      ...(closed.items.length > pageSize && lastClosed
        ? { nextClosedCursor: `${lastClosed.lastActivityAt}:${lastClosed.number}` }
        : {})
    }
  }
})

const SHOW = defineMethod({
  name: 'bots.items.owner.show',
  permission: 'workspace',
  share: SHARE_BY_BOT,
  params: BotItemsOwnerShow,
  handler: async (params, context) => {
    ownerActor(context)
    const { botItems } = context.runtime
    const record = await resolveItem(botItems.store(), params.item)
    assertItemsOfBot(params.botId, [record])
    const after = params.after !== undefined ? parseBotItemEventId(params.after) : 0
    const before = params.before !== undefined ? parseBotItemEventId(params.before) : 0
    if (after === null || before === null) {
      throw new BotItemError('invalid_argument', 'after and before take an event id such as e41.')
    }
    const limit = BOT_ITEM_LIMITS.eventsPage
    const [item] = botItemsForClient(
      await botItems.views([record], false, true, itemsViewerOf(context)),
      context
    )
    if (params.newest) {
      // The newest page; `earlierCursor` pages back from its oldest event.
      const events = await botItems.eventsBefore(record.uid, before, limit + 1)
      const page = events.slice(-limit)
      const first = page[0]
      return {
        item: item!,
        events: botItemEventsForClient(page, context),
        ...(events.length > limit && first ? { earlierCursor: first.id } : {})
      }
    }
    const events = await botItems.events(record.uid, after, limit + 1)
    const page = events.slice(0, limit)
    const last = page.at(-1)
    return {
      item: item!,
      events: botItemEventsForClient(page, context),
      ...(events.length > limit && last ? { nextCursor: last.id } : {})
    }
  }
})

const STATUS = defineMethod({
  name: 'bots.items.owner.status',
  permission: 'workspace',
  share: SHARE_BY_BOT,
  params: BotItemsOwnerStatus,
  handler: async (params, context) => {
    const actor = ownerActor(context)
    const { botItems } = context.runtime
    const store = botItems.store()
    const items = await Promise.all(params.items.map((ref) => resolveItem(store, ref)))
    assertItemsOfBot(params.botId, items)
    const uids = items.map((item) => item.uid)
    const result = await store.ownerStatus(
      {
        uids,
        to: params.status,
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
        ...(params.note !== undefined ? { note: params.note } : {}),
        ...(params.comment !== undefined ? { comment: params.comment } : {})
      },
      actor
    )
    botItems.changed(items)
    await botItems.sendOwedMail()
    return {
      items: result.items.map((entry) => ({
        uid: entry.uid,
        eventId: entry.eventId === null ? null : botItemEventId(entry.eventId),
        woke: entry.woke
      }))
    }
  }
})

const SNOOZE = defineMethod({
  name: 'bots.items.owner.snooze',
  permission: 'workspace',
  share: SHARE_BY_BOT,
  params: BotItemsOwnerSnooze,
  handler: async (params, context) => {
    const actor = ownerActor(context)
    const { botItems } = context.runtime
    const store = botItems.store()
    const items = await Promise.all(params.items.map((entry) => resolveItem(store, entry.item)))
    assertItemsOfBot(params.botId, items)
    const result = await store.ownerSnooze(
      {
        items: items.map((item, index) => ({
          uid: item.uid,
          othersLastEventId: parseBotItemEventId(params.items[index]!.othersLastEventId) ?? 0
        })),
        until: params.until
      },
      actor
    )
    botItems.changed(items)
    return {
      items: result.items.map((entry) => ({
        uid: entry.uid,
        eventId: entry.eventId === null ? null : botItemEventId(entry.eventId)
      }))
    }
  }
})

const OPENED = defineMethod({
  name: 'bots.items.owner.opened',
  permission: 'workspace',
  share: SHARE_BY_BOT,
  params: BotItemsOwnerOpened,
  handler: async (params, context) => {
    ownerActor(context)
    const { runtime } = context
    const latest = await runtime.botItems.store().latestEventId(params.botId)
    return { seenEventId: await markItemsSeen(context, params.botId, latest) }
  }
})

export const BOT_ITEMS_OWNER_METHODS = [
  LIST,
  SHOW,
  BOT_ITEM_OWNER_COMMENT_METHOD,
  STATUS,
  SNOOZE,
  OPENED
]
