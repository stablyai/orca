import {
  BotChatSearch,
  BotChatsOwn,
  BotChatTreeRead
} from '../../../../shared/rpc-contract/bots-params'
import { readSharedBotChatTree, runtimeBotChatTreeHost } from '../../../bots/bot-chat-tree-host'
import { readBotOwnChatPanes } from '../../../bots/bot-own-chat-panes'
import { runtimeBotChatSearchHost, searchBotChats } from '../../../bots/bot-chat-search-host'
import { defineMethod } from '../core'

export const BOT_CHAT_TREE_METHODS = [
  defineMethod({
    name: 'bots.chatTree',
    permission: 'workspace',
    params: BotChatTreeRead,
    handler: async (params, { runtime }) => readSharedBotChatTree(runtime, params)
  }),
  // Each bot's own side chats, pane and title, so its row's line says what any of them is doing.
  defineMethod({
    name: 'bots.chats.own',
    permission: 'workspace',
    params: BotChatsOwn,
    handler: async (params, { runtime }) => ({
      chats: await readBotOwnChatPanes(runtimeBotChatTreeHost(runtime), params.botIds)
    })
  }),
  defineMethod({
    name: 'bots.chats.search',
    permission: 'workspace',
    params: BotChatSearch,
    handler: (params, { runtime }) => searchBotChats(runtimeBotChatSearchHost(runtime), params)
  })
]
