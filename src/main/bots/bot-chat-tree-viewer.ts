// One chats tree on the agent's host, projected for whoever reads it: everyone sees every chat, with
// others' Homes named as theirs; a teammate's own Home is their Home row.
import type { BotChatTreeChat, BotChatTreeRead } from '../../shared/bots/bot-chat-tree'
import {
  HOME_CHAT_TITLE,
  NO_HOME_CHAT_ID,
  type BotChatHostChat,
  type BotChatHostTree
} from '../../shared/bots/bot-chat-tree-model'
import { botHomePlaceholderAccount, type BotHomeOf } from '../../shared/bots/bot-home-of'
import type { BotChatSearchResult } from '../../shared/bots/bot-chat-search'
import type { BotChatHostSearchResult } from './bot-chat-search-host'

export type BotChatTreeViewer =
  | { kind: 'owner'; personName: (accountId: string) => string }
  | {
      kind: 'teammate'
      accountId: string
      personName: (accountId: string) => string
      /** The owner as the share names them, for their Home row. */
      ownerName: string
    }

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

/** A search's answer as `viewer` lists those chats: each match keeps to a row the viewer has. */
export function botChatSearchForViewer(
  result: BotChatHostSearchResult,
  viewer: BotChatTreeViewer
): BotChatSearchResult {
  const { chats } = botChatTreeForViewer({ chats: result.chats, workspaceChats: {} }, viewer, {
    page: true
  })
  const listed = new Set(chats.map((chat) => chat.chatId))
  const asListed = (chatId: string): string =>
    viewer.kind === 'teammate' && botHomePlaceholderAccount(chatId) === viewer.accountId
      ? NO_HOME_CHAT_ID
      : chatId
  return {
    ...result,
    chats,
    matches: result.matches.flatMap((match) => {
      const chatId = asListed(match.chatId)
      return listed.has(chatId) ? [{ ...match, chatId }] : []
    })
  }
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
  const own = (chatId: string, of: BotHomeOf | undefined): boolean =>
    teammateHome(of, viewer.accountId) || botHomePlaceholderAccount(chatId) === viewer.accountId
  const asHome = (chatId: string): string =>
    botHomePlaceholderAccount(chatId) === viewer.accountId ? NO_HOME_CHAT_ID : chatId
  const self = { accountId: viewer.accountId, name: viewer.personName(viewer.accountId) }
  // Everyone's chats, as the owner sees them: their own Home is the Home row, anyone else's (the
  // owner's included) a row named for that person.
  const chats = tree.chats.flatMap((chat): BotChatTreeChat[] => {
    const of = chat.whoseHome
    if (own(chat.chatId, of)) {
      return [
        {
          ...teammateWireChat(chat),
          chatId: asHome(chat.chatId),
          origin: 'home',
          title: HOME_CHAT_TITLE,
          person: self
        }
      ]
    }
    if (!of) {
      return [teammateWireChat(chat)]
    }
    if (isPlaceholder(chat) && chat.runningTotal === 0) {
      return []
    }
    const name = of === 'owner' ? viewer.ownerName : viewer.personName(of.accountId)
    return [
      {
        ...teammateWireChat(chat),
        origin: 'side',
        homeOf: name,
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
            person: self,
            running: [],
            runningTotal: 0,
            finished: [],
            finishedTotal: 0,
            failedTotal: 0
          },
          ...chats
        ]
  const shown = new Set(withHome.map((chat) => chat.chatId))
  return {
    chats: withHome,
    workspaceChats: Object.fromEntries(
      Object.entries(tree.workspaceChats).flatMap(([workspace, chatId]) =>
        !botHomePlaceholderAccount(chatId) || shown.has(asHome(chatId))
          ? [[workspace, asHome(chatId)] as const]
          : []
      )
    )
  }
}
