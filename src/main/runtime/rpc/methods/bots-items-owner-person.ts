// Who acts from an Items panel, the owner or a teammate on a shared agent with the same powers, and
// their own seen mark: one place for every bots.items.owner.* method.
import { botItemEventId } from '../../../../shared/bots/bot-items'
import { botSharePersonName } from '../../../../shared/bots/bot-home-of'
import type { Bot } from '../../../../shared/bot-types'
import { BotItemError } from '../../../bots/bot-item-error'
import { BOT_ITEM_OWNER_VIEWER } from '../../../bots/bot-item-author'
import type { BotItemOwnerActor } from '../../../bots/bot-items-input'
import { botShareScopeOf } from '../../../bots/team-share/bot-share-chats'
import type { RpcContext } from '../core'
import { ownerOnly } from './bots-caller-gates'

const REFUSAL = 'Only your owner changes items this way, in Orca.'

/** The panel's person: the owner, or the teammate whose share device calls, by their account. */
export function ownerActor(context: RpcContext): BotItemOwnerActor {
  ownerOnly(context, REFUSAL)
  context.runtime.bots.assertEnabled()
  const share = botShareScopeOf(context)
  return {
    kind: 'owner',
    ...(context.pairedDeviceId ? { device: context.pairedDeviceId } : {}),
    ...(share
      ? {
          person: {
            accountId: share.accountId,
            name: botSharePersonName(
              context.runtime.bots.list().find((bot) => bot.id === share.botId) ?? {},
              share.accountId
            )
          }
        }
      : {})
  }
}

/** The caller as an unseen mark's viewer: the owner, or the teammate by account. */
export function itemsViewerOf(context: RpcContext): string {
  return botShareScopeOf(context)?.accountId ?? BOT_ITEM_OWNER_VIEWER
}

/** Items a call names must be its named bot's (the shared bot, on a teammate's call). */
export function assertItemsOfBot(
  botId: string | undefined,
  items: readonly { ownerBotId: string; number: number }[]
): void {
  const stray = botId === undefined ? undefined : items.find((item) => item.ownerBotId !== botId)
  if (stray) {
    throw new BotItemError('not_found', `No item ${stray.number}.`)
  }
}

/** The caller's own seen mark on the bot: the owner's, or the teammate's. */
export function itemsSeenOf(context: RpcContext, bot: Bot | undefined): number {
  const share = botShareScopeOf(context)
  return (share ? bot?.itemsSeenBy?.[share.accountId] : bot?.itemsSeen) ?? 0
}

/** Moves the caller's own seen mark up to `latest`; the mark as saved. */
export async function markItemsSeen(
  context: RpcContext,
  botId: string,
  latest: number
): Promise<string> {
  const { bots } = context.runtime
  const saved = itemsSeenOf(
    context,
    bots.list().find((bot) => bot.id === botId)
  )
  if (latest <= saved) {
    return botItemEventId(saved)
  }
  const share = botShareScopeOf(context)
  // One cursor per person in the bot's settings, so their desktop and paired phone agree.
  const updated = await bots.update(botId, (bot) =>
    share
      ? {
          itemsSeenBy: {
            ...bot.itemsSeenBy,
            [share.accountId]: Math.max(bot.itemsSeenBy?.[share.accountId] ?? 0, latest)
          }
        }
      : { itemsSeen: Math.max(bot.itemsSeen ?? 0, latest) }
  )
  return botItemEventId(itemsSeenOf(context, updated))
}
