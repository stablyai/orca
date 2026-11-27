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
import { botShareScopedView, hostOwnerName } from '../../../bots/team-share/bot-share-scoped-view'
import {
  botChatTreeForViewer,
  hostChatId,
  type BotChatTreeViewer
} from '../../../bots/bot-chat-tree-viewer'
import type { RpcContext } from '../core'

/** Who reads an agent's chats: the owner, or a teammate, who reaches every chat as the owner does
 *  (teammate-rules.ts, rule 1); only Homes and read marks read differently. */
function chatTreeViewerOf(
  context: Pick<RpcContext, 'callerScope'>
): Omit<BotChatTreeViewer, 'bot'> {
  const share = botShareScopeOf(context)
  return share
    ? { person: { accountId: share.accountId }, ownerName: hostOwnerName() }
    : { person: 'owner' }
}

export const BOT_CHAT_TREE_METHODS = [
  defineMethod({
    name: 'bots.chatTree',
    permission: 'workspace',
    share: SHARE_BY_BOT,
    params: BotChatTreeRead,
    handler: async (params, context) => {
      const { runtime } = context
      const bot = runtime.bots.list().find((entry) => entry.id === params.botId)
      const viewer = { ...chatTreeViewerOf(context), bot: bot ?? {} }
      const read =
        params.chatId === undefined
          ? params
          : { ...params, chatId: hostChatId(params.chatId, viewer.person) }
      const tree = await readSharedBotChatTree(runtime, read)
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
    share: SHARE_BY_BOT,
    params: BotChatSearch,
    handler: async (params, context) =>
      withBotChatPeople(
        context.runtime,
        context.runtime.bots.list().find((bot) => bot.id === params.botId),
        await searchBotChats(
          runtimeBotChatSearchHost(context.runtime),
          params,
          chatTreeViewerOf(context)
        )
      )
  })
]
