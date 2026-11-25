// One chats tree on the agent's host, projected for whoever reads it: the owner sees every chat, with
// teammates' Homes named as theirs; a teammate sees their own chats, with their Home as the Home row.
import type { BotChatTreeChat, BotChatTreeRead } from '../../shared/bots/bot-chat-tree'
import {
  HOME_CHAT_TITLE,
  NO_HOME_CHAT_ID,
  type BotChatHostChat,
  type BotChatHostTree
} from '../../shared/bots/bot-chat-tree-model'
import { botHomePlaceholderAccount, type BotHomeOf } from '../../shared/bots/bot-home-of'

export type BotChatTreeViewer =
  | { kind: 'owner'; personName: (accountId: string) => string }
  | { kind: 'teammate'; accountId: string; owns: (chatId: string) => boolean }

function wireChat({ whoseHome: _internal, ...chat }: BotChatHostChat): BotChatTreeChat {
  return chat
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
    const name = viewer.personName(of.accountId)
    return [
      {
        ...wireChat(chat),
        homeOf: name,
        ...(isPlaceholder(chat) ? { title: `${name}’s Home` } : {})
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
      return [wireChat(chat)]
    }
    return [
      {
        ...wireChat(chat),
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
