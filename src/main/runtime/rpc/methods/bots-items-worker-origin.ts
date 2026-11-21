// `worker-start --item`: the start names the item as its origin, which is honored only from the item's
// own bot's chat (never a worker or background run), on an open item. The Dispatch then keeps
// `bot-item:<uid>`, and the items host links it from orchestration's own record.
import { isOpenBotItemStatus } from '../../../../shared/bots/bot-items'
import { BotItemError } from '../../../bots/bot-item-error'
import { sessionCallerOf } from '../../orchestration/addressing/orchestration-caller-identity'
import type { RpcContext } from '../core'
import { itemsWriter } from './bots-items-caller'
import { resolveItem } from './bots-items-write-support'

export const BOT_ITEM_ORIGIN_PREFIX = 'bot-item:'

/** What worker-start's receipt names, so a wrong `--item` number is seen at once. */
export type LinkedBotItem = { number: number; title: string; chatTitle: string | null }

/** The checked origin to record, `bot-item:<uid>`, and the item it links; refused for anything else. */
export async function checkedWorkerOrigin(
  origin: string,
  context: Pick<RpcContext, 'runtime' | 'orchestrationCaller'>
): Promise<{ origin: string; linkedItem: LinkedBotItem }> {
  if (!origin.startsWith(BOT_ITEM_ORIGIN_PREFIX)) {
    throw new BotItemError('invalid_argument', 'A worker origin is set by `worker-start --item`.')
  }
  context.runtime.bots.assertEnabled()
  const sessionId = sessionCallerOf(context.orchestrationCaller)?.sessionId ?? undefined
  // The caller's session comes from its credentials, not its say-so.
  const writer = itemsWriter(sessionId, { runtime: context.runtime, pairedDeviceId: undefined })
  const item = await resolveItem(
    context.runtime.botItems.store(),
    origin.slice(BOT_ITEM_ORIGIN_PREFIX.length)
  )
  if (item.ownerBotId !== writer.bot.id) {
    throw new BotItemError('not_owner', `Item ${item.number} belongs to another bot.`)
  }
  if (!isOpenBotItemStatus(item.status)) {
    throw new BotItemError(
      'item_closed',
      `Item ${item.number} is ${item.status === 'done' ? 'done' : 'canceled'}; reopen it with \`orca bot item set ${item.number} --status in-progress\`, or add a new one.`
    )
  }
  return {
    origin: `${BOT_ITEM_ORIGIN_PREFIX}${item.uid}`,
    linkedItem: {
      number: item.number,
      title: item.title,
      chatTitle: context.runtime.botItems.owningChat(item).title
    }
  }
}
