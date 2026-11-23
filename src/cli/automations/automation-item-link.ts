// `automations create --item <n>`: the bot's item shows what will wake it for that item, so the item
// isn't taken for stalled.
import type { HandlerContext } from '../dispatch/dispatch'
import { RuntimeClientError } from '../runtime/connection/types'
import { callerChat } from './automation-caller-chat'

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
