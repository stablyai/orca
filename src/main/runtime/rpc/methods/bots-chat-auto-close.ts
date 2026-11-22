import {
  BotChatAutoCloseHold,
  BotChatAutoCloseTarget
} from '../../../../shared/rpc-contract/bots-params'
import type { BotChatAutoCloseView } from '../../../../shared/bots/bot-chat-auto-close'
import { botChatOfSession } from '../../../bots/bot-chat-auto-close-session'
import { defineMethod, type RpcContext } from '../core'

type AutoCloseAnswer = { autoClose: BotChatAutoCloseView | null }

/** Runs `act` on the session's bot chat, then answers its countdown; a session that is no bot's
 *  chat answers none. */
async function onChat(
  runtime: RpcContext['runtime'],
  sessionId: string,
  act?: (botId: string, chatId: string) => Promise<void>
): Promise<AutoCloseAnswer> {
  const autoClose = runtime.botChatAutoClose
  const chat = botChatOfSession(runtime, sessionId)
  if (!autoClose || !chat) {
    return { autoClose: null }
  }
  await act?.(chat.botId, chat.chatId)
  return { autoClose: autoClose.view(chat.botId, chat.chatId) }
}

export const BOT_CHAT_AUTO_CLOSE_METHODS = [
  defineMethod({
    name: 'bots.chat.autoClose',
    permission: 'workspace',
    params: BotChatAutoCloseTarget,
    handler: (params, { runtime }) => onChat(runtime, params.sessionId)
  }),
  defineMethod({
    name: 'bots.chat.keepOpen',
    permission: 'workspace',
    params: BotChatAutoCloseTarget,
    handler: (params, { runtime }) =>
      onChat(runtime, params.sessionId, (botId, chatId) =>
        runtime.botChatAutoClose!.keepOpen(botId, chatId)
      )
  }),
  defineMethod({
    name: 'bots.chat.closeNow',
    permission: 'workspace',
    params: BotChatAutoCloseTarget,
    handler: (params, { runtime }) =>
      onChat(runtime, params.sessionId, (botId, chatId) =>
        runtime.botChatAutoClose!.closeNow(botId, chatId)
      )
  }),
  defineMethod({
    name: 'bots.chat.reopen',
    permission: 'workspace',
    params: BotChatAutoCloseTarget,
    handler: (params, { runtime }) =>
      onChat(runtime, params.sessionId, (botId, chatId) =>
        runtime.botChatAutoClose!.reopen(botId, chatId)
      )
  }),
  defineMethod({
    name: 'bots.chat.autoCloseHold',
    permission: 'workspace',
    params: BotChatAutoCloseHold,
    handler: (params, { runtime }) =>
      onChat(runtime, params.sessionId, (botId, chatId) =>
        runtime.botChatAutoClose!.hold(botId, chatId, params.holder, params.hold)
      )
  })
]
