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
import { botShareScopeOf, withBotChatPeople } from '../../../bots/team-share/bot-share-chats'
import {
  botShareHostOwnerName,
  botShareScopedView,
  HOST_OWNER_FALLBACK_NAME
} from '../../../bots/team-share/bot-share-scoped-view'
import { botChatTreeForViewer, type BotChatTreeViewer } from '../../../bots/bot-chat-tree-viewer'
import { NO_HOME_CHAT_ID } from '../../../../shared/bots/bot-chat-tree-model'
import { botHomePlaceholderId, botSharePersonName } from '../../../../shared/bots/bot-home-of'

export const BOT_CHAT_TREE_METHODS = [
  defineMethod({
    name: 'bots.chatTree',
    permission: 'workspace',
    share: SHARE_BY_BOT,
    params: BotChatTreeRead,
    handler: async (params, context) => {
      const { runtime } = context
      const share = botShareScopeOf(context)
      // A teammate's Home row not made yet goes by the owner's empty id on their side.
      const read =
        share && params.chatId === NO_HOME_CHAT_ID
          ? { ...params, chatId: botHomePlaceholderId(share.accountId) }
          : params
      const tree = await readSharedBotChatTree(runtime, read)
      const bot = runtime.bots.list().find((entry) => entry.id === params.botId)
      const personName = (accountId: string): string => botSharePersonName(bot ?? {}, accountId)
      const viewer: BotChatTreeViewer = share
        ? {
            kind: 'teammate',
            accountId: share.accountId,
            personName,
            ownerName: botShareHostOwnerName() ?? HOST_OWNER_FALLBACK_NAME
          }
        : { kind: 'owner', personName }
      const view = botChatTreeForViewer(tree, viewer, { page: params.chatId !== undefined })
      return withBotChatPeople(runtime, bot, view)
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
          ? await readBotOwnChatPanes(host, share.botIds, share.owns, share.home)
          : await readBotOwnChatPanes(host, params.botIds)
      }
    }
  }),
  defineMethod({
    name: 'bots.chats.search',
    permission: 'workspace',
    share: 'not-shared',
    params: BotChatSearch,
    handler: async (params, { runtime }) =>
      withBotChatPeople(
        runtime,
        runtime.bots.list().find((bot) => bot.id === params.botId),
        await searchBotChats(runtimeBotChatSearchHost(runtime), params)
      )
  })
]
