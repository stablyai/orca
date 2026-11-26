// The owner's panel's list reads: every open item, and rows where a teammate's item names them, as their chats do.
import type { BotItem } from '../../../../shared/bots/bot-items'
import { botChatPerson } from '../../../../shared/bots/bot-chat-people'
import type { BotItemRecord } from '../../../bots/bot-items-schema'
import type { BotItemListQuery } from '../../../bots/bot-items-reads'
import type { BotItemsRemote } from '../../../bots/bot-items-ops'
import { BOT_ITEM_LIMITS, BOT_ITEM_OPEN_STATUSES } from '../../../../shared/bots/bot-items'
import type { RpcContext } from '../core'
import { itemsViewerOf } from './bots-items-owner-person'

/** Each row as the panel shows it: a teammates' item names them. */
export async function ownerViews(
  context: RpcContext,
  botId: string,
  records: readonly BotItemRecord[],
  summary: boolean | undefined
): Promise<BotItem[]> {
  const views = await context.runtime.botItems.views(
    records,
    summary,
    false,
    itemsViewerOf(context)
  )
  const bot = context.runtime.bots.list().find((entry) => entry.id === botId)
  return views.map((view, index) => {
    const accounts = records[index]?.actsForAccounts
    return accounts?.length && bot
      ? { ...view, people: accounts.map((account) => botChatPerson(bot, account)) }
      : view
  })
}

/** Every open item of the bot (or its chats, or one person's), however many, read a page at a time. */
export async function allOpenItems(
  store: BotItemsRemote,
  botId: string,
  chat: Pick<BotItemListQuery, 'chatIds' | 'actsForAccounts'>
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
