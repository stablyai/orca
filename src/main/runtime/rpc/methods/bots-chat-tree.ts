import { SHARE_BY_BOT, SHARE_SCOPED } from '../../../../shared/bots/bot-share-rpc-methods'
import {
  BotChatSearch,
  BotChatsOwn,
  BotChatTreeRead
} from '../../../../shared/rpc-contract/bots-params'
import { readSharedBotChatTree, runtimeBotChatTreeHost } from '../../../bots/bot-chat-tree-host'
import { readBotOwnChatPanes } from '../../../bots/bot-own-chat-panes'
import { runtimeBotChatSearchHost, searchBotChats } from '../../../bots/bot-chat-search-host'
import { defineMethod, type RpcContext } from '../core'
import {
  botShareChatFilter,
  botShareScopeOf,
  withBotChatPeople
} from '../../../bots/team-share/bot-share-chats'
import { BOTS_SHARE_EVERYONE_CHATS_RUNTIME_CAPABILITY } from '../../../../shared/bot-runtime-capabilities'
import {
  botShareHostOwnerName,
  botShareScopedView,
  HOST_OWNER_FALLBACK_NAME
} from '../../../bots/team-share/bot-share-scoped-view'
import {
  botChatSearchForViewer,
  botChatTreeForViewer,
  type BotChatTreeViewer
} from '../../../bots/bot-chat-tree-viewer'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { NO_HOME_CHAT_ID } from '../../../../shared/bots/bot-chat-tree-model'
import { botHomePlaceholderId, botSharePersonName } from '../../../../shared/bots/bot-home-of'

/** Who reads the bot's chats: the owner, or the teammate a share connection is. */
function botChatTreeViewerOf(
  context: Pick<RpcContext, 'callerScope' | 'clientCapabilities' | 'runtime'>,
  bot: Pick<Bot, 'shares'> | undefined
): BotChatTreeViewer {
  const share = botShareScopeOf(context)
  const personName = (accountId: string): string => botSharePersonName(bot ?? {}, accountId)
  return share
    ? {
        kind: 'teammate',
        accountId: share.accountId,
        personName,
        ownerName: botShareHostOwnerName() ?? HOST_OWNER_FALLBACK_NAME,
        everyone:
          context.clientCapabilities?.includes(BOTS_SHARE_EVERYONE_CHATS_RUNTIME_CAPABILITY) ??
          false,
        owns: botShareChatFilter(context.runtime, share)
      }
    : { kind: 'owner', personName }
}

/** Each chat named for whose it is, for a viewer that filters by person; an older teammate's Orca
 *  would print its own name on its own chats. */
function withViewerPeople<T extends { chats: BotChatTreeChat[] }>(
  runtime: OrcaRuntimeService,
  bot: Bot | undefined,
  viewer: BotChatTreeViewer,
  read: T
): T {
  return viewer.kind === 'teammate' && !viewer.everyone
    ? read
    : withBotChatPeople(runtime, bot, read)
}

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
      const viewer = botChatTreeViewerOf(context, bot)
      const view = botChatTreeForViewer(tree, viewer, { page: params.chatId !== undefined })
      return withViewerPeople(runtime, bot, viewer, view)
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
    handler: async (params, context) => {
      const { runtime } = context
      const bot = runtime.bots.list().find((entry) => entry.id === params.botId)
      const result = await searchBotChats(runtimeBotChatSearchHost(runtime), params)
      const viewer = botChatTreeViewerOf(context, bot)
      return withViewerPeople(runtime, bot, viewer, botChatSearchForViewer(result, viewer))
    }
  })
]
