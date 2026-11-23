// `automations create --item <n>`: the bot's item shows what will wake it for that item, so the item
// isn't taken for stalled.
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../shared/bot-runtime-capabilities'
import { isOpenBotItemStatus, type BotItem } from '../../shared/bots/bot-items'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { getOptionalStringFlag } from '../arguments/flags'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from './automation-caller-chat'

/** Why the automation can't be linked to this item, or null: it must be the bot's own open item. */
export function automationItemRefusal(
  item: Pick<BotItem, 'number' | 'status' | 'owner'>,
  botId: string
): string | null {
  if (item.owner.botId !== botId) {
    return `Item ${item.number} belongs to another bot; link the automation to one of yours.`
  }
  return isOpenBotItemStatus(item.status)
    ? null
    : `Item ${item.number} is closed; reopen it first or leave out --item.`
}

/** `--item`, checked before anything is created: the bot's own open item, on a host that links
 *  automations (an older one would store the link as a file path). */
export async function automationItemFlag(
  client: Pick<HandlerContext['client'], 'call'>,
  flags: HandlerContext['flags'],
  botId: string
): Promise<string | undefined> {
  const item = getOptionalStringFlag(flags, 'item')
  if (item === undefined) {
    return undefined
  }
  // Only a bot's chat links to items, so one from elsewhere is refused before it saves anything.
  const caller = callerChat()
  if (!caller.callerSessionId) {
    throw new RuntimeClientError(
      'invalid_argument',
      "Only a bot's chat links automations to items. Run this from the bot's chat, or leave out --item."
    )
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(BOTS_ITEM_WAITING_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot link automations to items. Update Orca on that host.'
    )
  }
  const shown = await client.call<{ item: BotItem }>('bots.items.show', {
    ...caller,
    botId,
    item,
    limit: 1
  })
  const refusal = automationItemRefusal(shown.result.item, botId)
  if (refusal) {
    throw new RuntimeClientError('invalid_argument', refusal)
  }
  return item
}

export async function linkAutomationToItem(
  client: HandlerContext['client'],
  item: string,
  automationId: string
): Promise<void> {
  const ref = `automation:${automationId}`
  try {
    await client.call('bots.items.link', { ...callerChat(), item, refs: [ref] })
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new RuntimeClientError(
      'invalid_argument',
      `Created automation ${automationId}, but linking it to item ${item} failed: ${why} Link it with \`orca bot item link ${item} ${ref}\`.`
    )
  }
}
