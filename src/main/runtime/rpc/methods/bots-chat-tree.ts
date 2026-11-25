import { SHARE_BY_BOT, SHARE_SCOPED } from '../../../../shared/bots/bot-share-rpc-methods'
import {
  BotChatSearch,
  BotChatsOwn,
  BotChatTreeRead
} from '../../../../shared/rpc-contract/bots-params'
import { readSharedBotChatTree, runtimeBotChatTreeHost } from '../../../bots/bot-chat-tree-host'
import { readBotOwnChatPanes } from '../../../bots/bot-own-chat-panes'
import { runtimeBotChatSearchHost, searchBotChats } from '../../../bots/bot-chat-search-host'
import { defineMethod } from '../core'
import { botShareChatFilter, botShareScopeOf } from '../../../bots/team-share/bot-share-chats'
import { botShareScopedView } from '../../../bots/team-share/bot-share-scoped-view'
import type { BotChatTreeRead as BotChatTree } from '../../../../shared/bots/bot-chat-tree'

/** A teammate's tree: their own chats, and only the workspaces under those. */
function botShareChatTree(tree: BotChatTree, owns: (chatId: string) => boolean): BotChatTree {
  return {
    chats: tree.chats.filter((chat) => owns(chat.chatId)),
    workspaceChats: Object.fromEntries(
      Object.entries(tree.workspaceChats).filter(([, chatId]) => owns(chatId))
    )
  }
}

export const BOT_CHAT_TREE_METHODS = [
  defineMethod({
    name: 'bots.chatTree',
    permission: 'workspace',
    share: SHARE_BY_BOT,
    params: BotChatTreeRead,
    handler: async (params, context) => {
      const tree = await readSharedBotChatTree(context.runtime, params)
      const share = botShareScopeOf(context)
      return share ? botShareChatTree(tree, botShareChatFilter(context.runtime, share)) : tree
    }
  }),
  // Each bot's own side chats, pane and title, so its row's line says what any of them is doing.
  defineMethod({
    name: 'bots.chats.own',
    permission: 'workspace',
    share: SHARE_SCOPED,
    params: BotChatsOwn,
    handler: async (params, context) => {
      const host = runtimeBotChatTreeHost(context.runtime)
      const share = botShareScopedView(context)?.['bots.chats.own']
      return {
        chats: share
          ? await readBotOwnChatPanes(host, share.botIds, share.owns)
          : await readBotOwnChatPanes(host, params.botIds)
      }
    }
  }),
  defineMethod({
    name: 'bots.chats.search',
    permission: 'workspace',
    share: 'not-shared',
    params: BotChatSearch,
    handler: (params, { runtime }) => searchBotChats(runtimeBotChatSearchHost(runtime), params)
  })
]
