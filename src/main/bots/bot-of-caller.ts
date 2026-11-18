import type { Bot } from '../../shared/bot-types'
import type { BotController } from './bot-controller'
import type { BotLookAroundStore } from './bot-look-around-store'
import { botOfSession } from './bot-session-tabs'

export type BotCallerRuntime = {
  bots: Pick<BotController, 'enabled' | 'list'>
  lookAround: Pick<BotLookAroundStore, 'botOfLook'>
}

/**
 * The bot a command came from: its chat or one of its Look around runs; null for the owner's own
 * terminal or agent. A session id names a chat only on its own host, so a paired client's names none.
 */
export function botOfCaller(
  runtime: BotCallerRuntime,
  callerSessionId: string | undefined,
  pairedDeviceId: string | undefined
): Bot | null {
  if (!callerSessionId || pairedDeviceId !== undefined || !runtime.bots.enabled()) {
    return null
  }
  const bot = botOfSession(runtime.bots, callerSessionId)
  if (bot) {
    return bot
  }
  const lookBotId = runtime.lookAround.botOfLook(callerSessionId)
  return lookBotId ? (runtime.bots.list().find((entry) => entry.id === lookBotId) ?? null) : null
}
