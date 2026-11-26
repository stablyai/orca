// Which bot a bots.tools.* call is about, and whether its caller may change that bot's tools.
import type { Bot } from '../../../../shared/bot-types'
import type { BotToolsTargetParams } from '../../../../shared/rpc-contract/bots-tools-params'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { InvalidArgumentError, type RpcContext } from '../core'

/** The bot named, or the one whose chat ran the command; a paired client's session names none. */
export function targetBot(params: BotToolsTargetParams, context: RpcContext): Bot {
  const { runtime } = context
  runtime.bots.assertEnabled()
  const caller = context.pairedDeviceId === undefined ? params.callerSessionId : undefined
  const bot = params.botId
    ? runtime.bots.list().find((entry) => entry.id === params.botId)
    : caller
      ? botOfSession(runtime.bots, caller)
      : null
  if (!bot) {
    throw new InvalidArgumentError(
      params.botId ? 'bot_not_found' : 'Name the bot with --bot, or run this from the bot’s chat.'
    )
  }
  return bot
}

/** A look-around run only reads, so it changes no tools. */
export function refuseFromLook(params: BotToolsTargetParams, context: RpcContext): void {
  const caller = context.pairedDeviceId === undefined ? params.callerSessionId : undefined
  if (caller && context.runtime.lookAround.botOfLook(caller)) {
    throw new InvalidArgumentError('Looking around can only read.')
  }
}
