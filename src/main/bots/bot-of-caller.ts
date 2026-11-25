import type { Bot } from '../../shared/bot-types'
import type { BotController } from './bot-controller'
import type { BotLookAroundStore } from './bot-look-around-store'
import { botOfSession } from './bot-session-tabs'
import { botToolRelay, type BotToolRelay } from './tool-relay/bot-tool-relay'

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

/** A token that names no bot now: its bot was deleted, or Orca restarted since its run started. */
export const BOT_TOKEN_ENDED = 'This bot run’s Orca token has ended. Start a new chat with the bot.'

export type BotTokenCaller = { kind: 'owner' } | { kind: 'bot'; bot: Bot } | { kind: 'ended' }

/**
 * Who a command came from, by the token Orca handed its bot's run (bot-tool-relay.ts), never by a
 * session id the run can rename. No token is the owner's own terminal or agent; a bot run that drops
 * its token passes as the owner, the same limit as its tools. A token names a bot only on its host.
 */
export function botOfToken(
  runtime: { bots: Pick<BotController, 'enabled' | 'list'> },
  botToken: string | undefined,
  pairedDeviceId: string | undefined,
  relay: Pick<BotToolRelay, 'botOf'> = botToolRelay
): BotTokenCaller {
  if (!botToken || pairedDeviceId !== undefined) {
    return { kind: 'owner' }
  }
  const botId = runtime.bots.enabled() ? relay.botOf(botToken) : null
  const bot = botId ? runtime.bots.list().find((entry) => entry.id === botId) : undefined
  return bot ? { kind: 'bot', bot } : { kind: 'ended' }
}
