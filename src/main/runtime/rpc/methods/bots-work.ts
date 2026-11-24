// A bot's work record over RPC: `orca bot work list`, and `forget` when its owner starts fresh.
import type { BotWorkListResult } from '../../../../shared/bots/bot-work-list'
import type { Bot } from '../../../../shared/bot-types'
import { BotWorkForget, BotWorkList } from '../../../../shared/rpc-contract/bots-work-params'
import { botOfSession } from '../../../bots/bot-session-tabs'
import { BOT_WORK_ASKED_PR_WAIT_MS } from '../../../bots/bot-work-record'
import { defineMethod, InvalidArgumentError, type RpcContext } from '../core'

/** A session id names a chat only on its own host, so a paired client's claim names none. */
function callerOf(callerSessionId: string | undefined, context: RpcContext): string | undefined {
  return context.pairedDeviceId === undefined ? callerSessionId : undefined
}

/** The named bot, else the one whose chat runs the command. A bot acts only on its own work; --bot
 *  is for its owner's own terminal. */
function botOf(params: { botId?: string; callerSessionId?: string }, context: RpcContext): Bot {
  const { runtime } = context
  const caller = callerOf(params.callerSessionId, context)
  const callerBot = caller ? botOfSession(runtime.bots, caller) : null
  if (callerBot && params.botId && params.botId !== callerBot.id) {
    throw new InvalidArgumentError('A bot can reach only its own work.')
  }
  const bot = params.botId
    ? runtime.bots.list().find((entry) => entry.id === params.botId)
    : callerBot
  if (!bot) {
    throw new InvalidArgumentError('Name the bot with --bot, or run this from the bot’s chat.')
  }
  return bot
}

export const BOT_WORK_METHODS = [
  defineMethod({
    name: 'bots.work.list',
    permission: 'workspace',
    params: BotWorkList,
    handler: async (params, context): Promise<BotWorkListResult> => {
      context.runtime.bots.assertEnabled()
      const bot = botOf(params, context)
      const items = await context.runtime.botWork.list(bot.id, BOT_WORK_ASKED_PR_WAIT_MS)
      return { items, botName: bot.name }
    }
  }),
  defineMethod({
    name: 'bots.work.forget',
    permission: 'workspace',
    params: BotWorkForget,
    handler: async (params, context) => {
      context.runtime.bots.assertEnabled()
      const caller = callerOf(params.callerSessionId, context)
      return { forgotten: caller ? await context.runtime.botWork.forget(caller) : false }
    }
  })
]
