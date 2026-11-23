// `bots.items.owner.*`: the owner's panel, on the desktop or a paired phone; an agent's CLI is refused.
// Every comment and status change mails the item's chat, one mail per action and chat; a snooze mails none.
import {
  BOT_ITEM_LIMITS,
  BOT_ITEM_OPEN_STATUSES,
  BOT_ITEM_STATUSES,
  botItemEventId,
  parseBotItemEventId
} from '../../../../shared/bots/bot-items'
import {
  BotItemsOwnerComment,
  BotItemsOwnerList,
  BotItemsOwnerOpened,
  BotItemsOwnerShow,
  BotItemsOwnerSnooze,
  BotItemsOwnerStatus
} from '../../../../shared/rpc-contract/bots-items-params'
import { AGENT_SESSION_ATTACHMENTS_DIR_NAME } from '../../../../shared/agent-session/agent-session-attachments'
import { BotItemError } from '../../../bots/bot-item-error'
import { admitBotItemCommentAttachments } from '../../../bots/bot-item-comment-attachments'
import {
  getAgentSessionAttachmentClaimer,
  getAgentSessionAttachmentStore
} from '../../../native-chat/agent-session-attachments/agent-session-attachment-store-registry'
import { botChatTakingMail } from './bots-chats'
import type { BotItemOwnerActor } from '../../../bots/bot-items-input'
import type { BotItemRecord } from '../../../bots/bot-items-schema'
import type { BotItemsRemote } from '../../../bots/bot-items-ops'
import { defineMethod, type RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'
import { parseCursor, resolveItem } from './bots-items-write-support'
import {
  botItemCountsForClient,
  botItemEventsForClient,
  botItemsForClient
} from './bots-items-waiting-compat'

const REFUSAL = 'Only your owner changes items this way, in Orca.'

function ownerActor(context: RpcContext): BotItemOwnerActor {
  ownerOnly(context, REFUSAL)
  context.runtime.bots.assertEnabled()
  return context.pairedDeviceId
    ? { kind: 'owner', device: context.pairedDeviceId }
    : { kind: 'owner' }
}

/** Every open item of the bot (or its chats), however many, read a page at a time. */
async function allOpenItems(
  store: BotItemsRemote,
  botId: string,
  chat: { chatIds?: readonly string[] }
): Promise<BotItemRecord[]> {
  const open: BotItemRecord[] = []
  let cursor: { at: number; number: number } | undefined
  for (;;) {
    const page = await store.list({
      botId,
      ...chat,
      statuses: BOT_ITEM_OPEN_STATUSES,
      limit: BOT_ITEM_LIMITS.listPageMax + 1,
      ...(cursor ? { cursor } : {})
    })
    open.push(...page.items.slice(0, BOT_ITEM_LIMITS.listPageMax))
    const last = page.items[BOT_ITEM_LIMITS.listPageMax - 1]
    if (page.items.length <= BOT_ITEM_LIMITS.listPageMax || !last) {
      return open
    }
    cursor = { at: last.lastActivityAt, number: last.number }
  }
}

const LIST = defineMethod({
  name: 'bots.items.owner.list',
  permission: 'workspace',
  params: BotItemsOwnerList,
  handler: async (params, context) => {
    ownerActor(context)
    const { botItems } = context.runtime
    const store = botItems.store()
    // An older client names one chat; a group's panel names its rooms' member sessions.
    const chatIds = params.chatIds ?? (params.chatId !== undefined ? [params.chatId] : undefined)
    const chat = chatIds ? { chatIds } : {}
    // Read after the rows, so a mark another device moved meanwhile is the one sent.
    const seenEventId = (): string =>
      botItemEventId(
        context.runtime.bots.list().find((bot) => bot.id === params.botId)?.itemsSeen ?? 0
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
        items: botItemsForClient(await botItems.views(named.items, params.summary), context),
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
        await botItems.views([...stillOpen, ...closedRows], params.summary),
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
  params: BotItemsOwnerShow,
  handler: async (params, context) => {
    ownerActor(context)
    const { botItems } = context.runtime
    const record = await resolveItem(botItems.store(), params.item)
    const after = params.after !== undefined ? parseBotItemEventId(params.after) : 0
    const before = params.before !== undefined ? parseBotItemEventId(params.before) : 0
    if (after === null || before === null) {
      throw new BotItemError('invalid_argument', 'after and before take an event id such as e41.')
    }
    const limit = BOT_ITEM_LIMITS.eventsPage
    const [item] = botItemsForClient(await botItems.views([record], false, true), context)
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

const COMMENT = defineMethod({
  name: 'bots.items.owner.comment',
  permission: 'workspace',
  params: BotItemsOwnerComment,
  handler: async (params, context) => {
    const actor = ownerActor(context)
    const { botItems } = context.runtime
    const store = botItems.store()
    const item = await resolveItem(store, params.item)
    const bot = context.runtime.bots.list().find((entry) => entry.id === item.ownerBotId)
    if (params.images?.length || params.text.includes(AGENT_SESSION_ATTACHMENTS_DIR_NAME)) {
      // The attachment store and its claims come up with the structured chat host.
      await context.runtime.ensureStructuredAgentSessionHost().catch(() => undefined)
    }
    // Admitted and claimed for the item's chat before the event: a failed write leaves only a claim
    // that chat already prunes, and a retry re-claims the same uploads.
    const { images } = await admitBotItemCommentAttachments(
      {
        store: getAgentSessionAttachmentStore(),
        // This host's own window: a dropped on-disk image is copied in; a paired client sends store paths.
        local: context.caller?.kind === 'desktop',
        claim: getAgentSessionAttachmentClaimer(),
        chat: async () => (bot ? botChatTakingMail(context.runtime, bot, item.chatId) : null)
      },
      params.text,
      params.images ?? []
    )
    const outcome = await store.ownerComment(
      item.uid,
      params.text,
      actor,
      images,
      undefined,
      params.requestId,
      params.questionId === undefined ? undefined : (parseBotItemEventId(params.questionId) ?? -1),
      params.plain === true,
      params.skills
    )
    botItems.changed([item])
    // The comment is stored and its mail owed: the reply never waits on the chat taking it.
    void botItems
      .sendOwedMail()
      .catch((error: unknown) => console.warn('[bots] items: mailing a comment failed', error))
    return { eventId: outcome.eventId === null ? null : botItemEventId(outcome.eventId) }
  }
})

const STATUS = defineMethod({
  name: 'bots.items.owner.status',
  permission: 'workspace',
  params: BotItemsOwnerStatus,
  handler: async (params, context) => {
    const actor = ownerActor(context)
    const { botItems } = context.runtime
    const store = botItems.store()
    const items = await Promise.all(params.items.map((ref) => resolveItem(store, ref)))
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
  params: BotItemsOwnerSnooze,
  handler: async (params, context) => {
    const actor = ownerActor(context)
    const { botItems } = context.runtime
    const store = botItems.store()
    const items = await Promise.all(params.items.map((entry) => resolveItem(store, entry.item)))
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
  params: BotItemsOwnerOpened,
  handler: async (params, context) => {
    ownerActor(context)
    const { runtime } = context
    const latest = await runtime.botItems.store().latestEventId(params.botId)
    const saved = runtime.bots.list().find((bot) => bot.id === params.botId)?.itemsSeen ?? 0
    // One cursor per bot in its settings, so the desktop and a paired phone agree.
    const seen =
      latest > saved
        ? ((
            await runtime.bots.update(params.botId, (bot) => ({
              itemsSeen: Math.max(bot.itemsSeen ?? 0, latest)
            }))
          ).itemsSeen ?? latest)
        : saved
    return { seenEventId: botItemEventId(seen) }
  }
})

export const BOT_ITEMS_OWNER_METHODS = [LIST, SHOW, COMMENT, STATUS, SNOOZE, OPENED]
