// `automations create --item <n>`: the bot's item shows what will wake it for that item, so the item
// isn't taken for stalled.
import { BOTS_ITEM_WAITING_CAPABILITY } from '../../shared/bot-runtime-capabilities'
import type { RuntimeStatus } from '../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { getOptionalStringFlag } from '../arguments/flags'
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from './automation-caller-chat'

/** `--item`, checked before anything is created: a host from before item-linked automations would
 *  store the link as a file path. */
export async function automationItemFlag(
  client: HandlerContext['client'],
  flags: HandlerContext['flags']
): Promise<string | undefined> {
  const item = getOptionalStringFlag(flags, 'item')
  if (item === undefined) {
    return undefined
  }
  const status = await client.call<RuntimeStatus>('status.get')
  if (!status.result.capabilities?.includes(BOTS_ITEM_WAITING_CAPABILITY)) {
    throw new RuntimeClientError(
      'incompatible_runtime',
      'This Orca host cannot link automations to items. Update Orca on that host.'
    )
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
