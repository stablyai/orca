import { newBotName } from '../../shared/bot-types'

/** A new bot's name: `requested`, or with none "New bot" numbered past the others; refuses one
 *  another bot holds, in any case. */
export function freeBotName(
  bots: readonly { id: string; name: string }[],
  requested: string
): string {
  const name = newBotName(requested, bots)
  assertBotNameFree(bots, name, null)
  return name
}

/** Refuses `name` when a bot other than `exceptBotId` holds it, in any case. */
export function assertBotNameFree(
  bots: readonly { id: string; name: string }[],
  name: string,
  exceptBotId: string | null
): void {
  const key = name.trim().toLowerCase()
  if (bots.some((bot) => bot.id !== exceptBotId && bot.name.toLowerCase() === key)) {
    throw new Error('bot_name_taken')
  }
}
