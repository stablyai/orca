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
  BOT_OWNER_FALLBACK_NAME,
  botHomePlaceholderAccount,
  botHomePlaceholderId,
  botSharePersonName,
  personHomeName,
  sameBotHome,
  type BotHomeOf
} from '../../shared/bots/bot-home-of'

export type BotChatTreeViewer = {
  bot: Pick<Bot, 'shares'>
  person: BotHomeOf
  /** The owner's name, for their Home on a teammate's tree; null when the host is signed out. */
  ownerName?: string | null
}

/** The owner's Home not made yet, as a teammate's tree lists it; each viewer's own unmade Home goes
 *  by NO_HOME_CHAT_ID. */
export const OWNER_UNMADE_HOME_ID = 'no-home'

/** A person's Home not made yet, by its id on the host. */
function unmadeHomeId(of: BotHomeOf): string {
  return of === 'owner' ? NO_HOME_CHAT_ID : botHomePlaceholderId(of.accountId)
}

/** A chat's id as `person` reads it. Only unmade Homes differ: their own goes by NO_HOME_CHAT_ID, and
 *  on a teammate's side the owner's goes by OWNER_UNMADE_HOME_ID. */
export function viewerChatId(chatId: string, person: BotHomeOf): string {
  if (person === 'owner') {
    return chatId
  }
  return chatId === unmadeHomeId(person)
    ? NO_HOME_CHAT_ID
    : chatId === NO_HOME_CHAT_ID
      ? OWNER_UNMADE_HOME_ID
      : chatId
}

/** The host's id of a chat `person` names (`viewerChatId`'s inverse). */
export function hostChatId(chatId: string, person: BotHomeOf): string {
  if (person === 'owner') {
    return chatId
  }
  return chatId === NO_HOME_CHAT_ID
    ? unmadeHomeId(person)
    : chatId === OWNER_UNMADE_HOME_ID
      ? NO_HOME_CHAT_ID
      : chatId
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

/** A Home not made yet, the owner's or a teammate's, by its host id. */
function isUnmadeHome(chatId: string): boolean {
  return chatId === NO_HOME_CHAT_ID || botHomePlaceholderAccount(chatId) !== null
}

function personName(viewer: BotChatTreeViewer, of: BotHomeOf): string {
  return of === 'owner'
    ? (viewer.ownerName ?? BOT_OWNER_FALLBACK_NAME)
    : botSharePersonName(viewer.bot, of.accountId)
}

/** Rows are added only on a full read; a page read (`page`) keeps the rows it was asked for. */
export function botChatTreeForViewer(
  tree: BotChatHostTree,
  viewer: BotChatTreeViewer,
  { page }: { page: boolean }
): BotChatTreeRead {
  const account = viewer.person === 'owner' ? null : viewer.person.accountId
  const chats = tree.chats.flatMap((chat): BotChatTreeChat[] => {
    const of = chat.whoseHome
    const wire = { ...wireChat(chat, viewer), chatId: viewerChatId(chat.chatId, viewer.person) }
    if (!of) {
      return [wire]
    }
    if (sameBotHome(of, viewer.person)) {
      return [{ ...wire, origin: 'home', title: HOME_CHAT_TITLE }]
    }
    // Another's Home not made yet shows only while a closed chat's worker runs under it.
    if (isUnmadeHome(chat.chatId) && chat.runningTotal === 0) {
      return []
    }
    const name = personName(viewer, of)
    // A Home not made yet has no record to be titled by; the owner's record reads "Home".
    const title = isUnmadeHome(chat.chatId) || of === 'owner' ? personHomeName(name) : wire.title
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
  const shown = new Set(withHome.map((chat) => chat.chatId))
  return {
    chats: withHome,
    workspaceChats: Object.fromEntries(
      Object.entries(tree.workspaceChats).flatMap(([workspace, chatId]) => {
        const id = viewerChatId(chatId, viewer.person)
        return !isUnmadeHome(chatId) || shown.has(id) ? [[workspace, id] as const] : []
      })
    )
  }
}
