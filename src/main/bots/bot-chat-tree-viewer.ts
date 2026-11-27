// One chats tree on the agent's host, projected for whoever reads it: the owner sees every chat, with
// teammates' Homes named as theirs; a teammate sees their own chats, with their Home as the Home row.
import type { BotChatTreeChat, BotChatTreeRead } from '../../shared/bots/bot-chat-tree'
import {
  HOME_CHAT_TITLE,
  NO_HOME_CHAT_ID,
  type BotChatHostChat,
  type BotChatHostTree
} from '../../shared/bots/bot-chat-tree-model'
import type { Bot } from '../../shared/bot-types'
import {
  botHomeName,
  botHomePlaceholderAccount,
  botSharePersonName,
  type BotHomeOf
} from '../../shared/bots/bot-home-of'

export type BotChatTreeViewer =
  | { kind: 'owner'; bot: Pick<Bot, 'shares'> }
  | { kind: 'teammate'; accountId: string; owns: (chatId: string) => boolean }

function wireChat({ whoseHome: _internal, ...chat }: BotChatHostChat): BotChatTreeChat {
  return chat
}

/** A teammate's row: the host's tabs are the owner's, so none goes to them (`withViewerChatTabs`). */
function teammateWireChat({ tab: _hostTab, ...chat }: BotChatHostChat): BotChatTreeChat {
  return wireChat(chat)
}

function isPlaceholder(chat: BotChatHostChat): boolean {
  return botHomePlaceholderAccount(chat.chatId) !== null
}

function teammateHome(whoseHome: BotHomeOf | undefined, accountId: string): boolean {
  return whoseHome !== undefined && whoseHome !== 'owner' && whoseHome.accountId === accountId
}

/** Rows are added only on a full read; a page read (`page`) keeps the rows it was asked for. */
export function botChatTreeForViewer(
  tree: BotChatHostTree,
  viewer: BotChatTreeViewer,
  { page }: { page: boolean }
): BotChatTreeRead {
  return viewer.kind === 'owner' ? ownerView(tree, viewer) : teammateView(tree, viewer, page)
}

function ownerView(
  tree: BotChatHostTree,
  viewer: Extract<BotChatTreeViewer, { kind: 'owner' }>
): BotChatTreeRead {
  const chats = tree.chats.flatMap((chat): BotChatTreeChat[] => {
    const of = chat.whoseHome
    if (!of || of === 'owner') {
      return [wireChat(chat)]
    }
    // A teammate's Home not made yet shows only while their closed chat's worker runs under it.
    if (isPlaceholder(chat) && chat.runningTotal === 0) {
      return []
    }
    // A Home not made yet has no record to be titled by.
    return [
      {
        ...wireChat(chat),
        homeOf: botSharePersonName(viewer.bot, of.accountId),
        ...(isPlaceholder(chat) ? { title: botHomeName(viewer.bot, of) } : {})
      }
    ]
  })
  const shown = new Set(chats.map((chat) => chat.chatId))
  return {
    chats,
    workspaceChats: Object.fromEntries(
      Object.entries(tree.workspaceChats).filter(
        ([, chatId]) => !botHomePlaceholderAccount(chatId) || shown.has(chatId)
      )
    )
  }
}

function teammateView(
  tree: BotChatHostTree,
  viewer: Extract<BotChatTreeViewer, { kind: 'teammate' }>,
  page: boolean
): BotChatTreeRead {
  const byId = new Map(tree.chats.map((chat) => [chat.chatId, chat]))
  // By identity, so their Home not made yet (no record says whom it acts for) is never dropped.
  const theirs = (chatId: string): boolean =>
    teammateHome(byId.get(chatId)?.whoseHome, viewer.accountId) ||
    botHomePlaceholderAccount(chatId) === viewer.accountId ||
    viewer.owns(chatId)
  const asHome = (chatId: string): string =>
    botHomePlaceholderAccount(chatId) === viewer.accountId ? NO_HOME_CHAT_ID : chatId
  const chats = tree.chats.flatMap((chat): BotChatTreeChat[] => {
    if (!theirs(chat.chatId)) {
      return []
    }
    if (!teammateHome(chat.whoseHome, viewer.accountId)) {
      return [teammateWireChat(chat)]
    }
    return [
      {
        ...teammateWireChat(chat),
        chatId: asHome(chat.chatId),
        origin: 'home',
        title: HOME_CHAT_TITLE
      }
    ]
  })
  const hasHome = chats.some((chat) => chat.origin === 'home' && !chat.closed)
  const withHome =
    hasHome || page
      ? chats
      : [
          {
            chatId: NO_HOME_CHAT_ID,
            title: HOME_CHAT_TITLE,
            origin: 'home' as const,
            live: 'idle' as const,
            lastActiveAt: 0,
            unread: false,
            closed: false,
            running: [],
            runningTotal: 0,
            finished: [],
            finishedTotal: 0,
            failedTotal: 0
          },
          ...chats
        ]
  return {
    chats: withHome,
    workspaceChats: Object.fromEntries(
      Object.entries(tree.workspaceChats).flatMap(([workspace, chatId]) =>
        theirs(chatId) ? [[workspace, asHome(chatId)] as const] : []
      )
    )
  }
}
