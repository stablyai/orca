import type { Bot } from '../../../../shared/bot-types'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { InvalidArgumentError, type RpcContext } from '../core'

/** The bot `botId` names, else the calling chat's; a session id names a chat only on its own host,
 *  so a paired client's claim names none. */
export function namedOrCallerBot(
  params: { botId?: string; callerSessionId?: string },
  context: Pick<RpcContext, 'runtime' | 'pairedDeviceId'>
): { bot: Bot; caller: string | undefined; callerBot: Bot | null } {
  const { runtime } = context
  const caller = context.pairedDeviceId === undefined ? params.callerSessionId : undefined
  const callerBot = caller ? botOfSession(runtime.bots, caller) : null
  const bot = params.botId
    ? runtime.bots.list().find((entry) => entry.id === params.botId)
    : callerBot
  if (!bot) {
    throw new InvalidArgumentError(
      params.botId ? 'bot_not_found' : 'Name the bot with --bot, or run this from the bot’s chat.'
    )
  }
  return { bot, caller, callerBot }
}
