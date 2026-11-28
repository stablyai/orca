// Whose Home Chat a call opens or resets: a teammate's share connection names theirs alone; an agent
// names the Home it runs in; anyone else, the owner's. Params never choose a person.
import type { Bot } from '../../../../shared/bot-types'
import { botHomeOfSession, type BotHomeOf } from '../../../../shared/bots/bot-home-of'
import type { BotShareCallerScope } from '../callers/rpc-caller-scope'
import { InvalidArgumentError } from '../core'

export function callerHomeOf(scope: Pick<BotShareCallerScope, 'accountId'> | null): BotHomeOf {
  return scope ? { accountId: scope.accountId } : 'owner'
}

/** New Home Chat's person. From an agent's chat, only a Home resets, and only its own person's (by
 *  /clear root, so a continued Home still counts); any other chat is refused. */
export function newHomeChatOf(input: {
  scope: Pick<BotShareCallerScope, 'accountId'> | null
  bot: Bot
  caller: string | undefined
  callerBot: Pick<Bot, 'id'> | null
  rootOf: (sessionId: string) => string
}): BotHomeOf {
  const { scope, bot, caller, callerBot, rootOf } = input
  if (scope || !caller || !callerBot) {
    return callerHomeOf(scope)
  }
  const home = callerBot.id === bot.id ? botHomeOfSession(bot, caller, rootOf) : null
  if (!home) {
    // Another chat ending a Home Chat would cut off a conversation it isn't part of.
    throw new InvalidArgumentError('Only the bot’s own Home Chat can start a new Home Chat.')
  }
  return home
}
