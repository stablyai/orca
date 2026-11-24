// `bots.runChats`: which of a bot's automation-run chats a check would close now, and what keeps the
// rest open; reads only, so the owner sees the count before turning closing on.
import { BotRunChats } from '../../../../shared/rpc-contract/bots-run-chats-params'
import { previewRunChats } from '../../../bots/bot-run-chat-closer'
import { defineMethod } from '../core'
import { namedOrCallerBot } from './bots-caller-bot'

export const BOT_RUN_CHATS_METHOD = defineMethod({
  name: 'bots.runChats',
  permission: 'workspace',
  params: BotRunChats,
  handler: async (params, context) => {
    const { bot } = namedOrCallerBot(params, context)
    return { botId: bot.id, ...(await previewRunChats(context.runtime, bot)) }
  }
})
