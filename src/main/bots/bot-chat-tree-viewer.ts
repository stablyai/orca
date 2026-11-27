// One chats tree on the agent's host, projected for whoever reads it: every chat of the agent, for the
// owner and each teammate alike (teammate-rules.ts, rule 1). Only Homes are viewer-relative: the
// viewer's own is the Home row; everyone else's lists by its person's name.
import type { BotChatTreeChat, BotChatTreeRead } from '../../shared/bots/bot-chat-tree'
import {
  HOME_CHAT_TITLE,
  NO_HOME_CHAT_ID,
  type BotChatHostChat,
  type BotChatHostTree
} from '../../shared/bots/bot-chat-tree-model'
import type { Bot } from '../../shared/bot-types'
import {
  botHomePlaceholderAccount,
  botSharePersonName,
  personHomeName,
  type BotHomeOf
} from '../../shared/bots/bot-home-of'

export type BotChatTreeViewer = {
  bot: Pick<Bot, 'shares'>
  person: BotHomeOf
  /** The owner's name, for their Home on a teammate's tree; null when the host is signed out. */
  ownerName?: string | null
}

const OWNER_FALLBACK_NAME = 'Owner'

function sameHome(a: BotHomeOf, b: BotHomeOf): boolean {
  return a === 'owner' ? b === 'owner' : b !== 'owner' && a.accountId === b.accountId
}

/** A row as this viewer gets it. The host's tabs, read marks and thread marks are the owner's
 *  (rule 6), so none goes to a teammate: their tabs are their own (`withViewerChatTabs`), and their
 *  desktop reads unread against its own acks of `turnDone`. */
function wireChat(
  { whoseHome: _internal, ...chat }: BotChatHostChat,
  viewer: BotChatTreeViewer
): BotChatTreeChat {
  if (viewer.person === 'owner') {
    return chat
  }
  const { tab: _hostTab, unseen: _ownerSeen, ...theirs } = chat
  return { ...theirs, unread: false }
}

function isPlaceholder(chat: BotChatHostChat): boolean {
  return botHomePlaceholderAccount(chat.chatId) !== null
}

function personName(viewer: BotChatTreeViewer, of: BotHomeOf): string {
  return of === 'owner'
    ? (viewer.ownerName ?? OWNER_FALLBACK_NAME)
    : botSharePersonName(viewer.bot, of.accountId)
}

/** Rows are added only on a full read; a page read (`page`) keeps the rows it was asked for. */
export function botChatTreeForViewer(
  tree: BotChatHostTree,
  viewer: BotChatTreeViewer,
  { page }: { page: boolean }
): BotChatTreeRead {
  const account = viewer.person === 'owner' ? null : viewer.person.accountId
  // Their own Home not made yet goes by the owner's empty id on their side.
  const asHome = (chatId: string): string =>
    account !== null && botHomePlaceholderAccount(chatId) === account ? NO_HOME_CHAT_ID : chatId
  const chats = tree.chats.flatMap((chat): BotChatTreeChat[] => {
    const of = chat.whoseHome
    const wire = wireChat(chat, viewer)
    if (!of) {
      return [wire]
    }
    if (sameHome(of, viewer.person)) {
      return [{ ...wire, chatId: asHome(chat.chatId), origin: 'home', title: HOME_CHAT_TITLE }]
    }
    // Another's Home not made yet shows only while their closed chat's worker runs under it.
    if (isPlaceholder(chat) && chat.runningTotal === 0) {
      return []
    }
    const name = personName(viewer, of)
    // A Home not made yet has no record to be titled by; the owner's record reads "Home".
    const title = isPlaceholder(chat) || of === 'owner' ? personHomeName(name) : wire.title
    return [{ ...wire, origin: 'side', homeOf: name, title }]
  })
  const hasHome = chats.some((chat) => chat.origin === 'home' && !chat.closed)
  const withHome =
    hasHome || page || account === null
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
  const shown = new Set(chats.map((chat) => chat.chatId))
  return {
    chats: withHome,
    workspaceChats: Object.fromEntries(
      Object.entries(tree.workspaceChats).flatMap(([workspace, chatId]) => {
        const id = asHome(chatId)
        return !botHomePlaceholderAccount(id) || shown.has(id) ? [[workspace, id] as const] : []
      })
    )
  }
}
