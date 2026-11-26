// A teammate's chats on a shared bot: they read and act in any of its chats, as the owner does; which
// are their own decides only their defaults (their Activity, the empty chat New chat reopens).
import type { BotRequestPerson } from '../../../shared/bots/bot-acts-for'
import { actsForOwner, shareOwnsChat } from '../../../shared/bots/bot-acts-for'
import type { Bot } from '../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../shared/bots/bot-chat-tree'
import { botChatPerson } from '../../../shared/bots/bot-chat-people'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { RpcContext } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { botOfSession } from '../bot-session-tabs'
import {
  botHomesOfChats,
  readBotConversationActsFor,
  type BotConversationActsForSources
} from '../bot-conversation-acts-for'

export function botShareScopeOf(
  context: Pick<RpcContext, 'callerScope'>
): BotShareCallerScope | null {
  return context.callerScope?.kind === 'bot-share' ? context.callerScope : null
}

/** Whom a teammate's new chat acts for: them, as their share row names them, never the owner. */
export function botShareAsker(scope: BotShareCallerScope): BotRequestPerson {
  return {
    kind: 'person',
    source: 'orca',
    userId: scope.accountId,
    name: scope.name,
    workspaceId: null,
    role: 'member'
  }
}

/** By chat id (its /clear root): the teammate's when Orca's record says it acts for them alone. */
export function botShareChatFilter(
  sources: BotConversationActsForSources,
  scope: BotShareCallerScope
): (chatId: string) => boolean {
  return (chatId) => {
    const recorded = readBotConversationActsFor(sources, chatId)
    return recorded !== undefined && shareOwnsChat(recorded.actsFor, scope.accountId)
  }
}

/** Whether a session is a chat of the shared bot, whoever started it. */
export function botShareSeesSession(
  sources: Pick<OrcaRuntimeService, 'bots'>,
  scope: BotShareCallerScope,
  sessionId: string
): boolean {
  return botOfSession(sources.bots, sessionId)?.id === scope.botId
}

/** `botShareSeesSession` for a stream that asks again on every event: a chat stays in its bot's home,
 *  so only the yes answers are kept. */
export function botShareSessionFilter(
  sources: Pick<OrcaRuntimeService, 'bots'>,
  scope: BotShareCallerScope
): (sessionId: string) => boolean {
  const seen = new Set<string>()
  return (sessionId) => {
    if (seen.has(sessionId)) {
      return true
    }
    const sees = botShareSeesSession(sources, scope, sessionId)
    if (sees) {
      seen.add(sessionId)
    }
    return sees
  }
}

/** Whose empty chat New chat may open again: for the owner, theirs (or one Orca never recorded, as
 *  chats from before records were kept); for a teammate, their own. Never anyone else's. */
export function emptyChatReusableBy(
  sources: BotConversationActsForSources,
  scope: BotShareCallerScope | null
): (chatId: string) => boolean {
  const teammates = scope ? botShareChatFilter(sources, scope) : null
  return (chatId) => {
    if (teammates) {
      return teammates(chatId)
    }
    const recorded = readBotConversationActsFor(sources, chatId)
    return recorded === undefined || actsForOwner(recorded.actsFor)
  }
}

/** The owner's chats, each a teammate's own naming them, by whose Home it falls under: the one place
 *  the desktop and the phone learn whose a chat is. A chat Orca never recorded stays the owner's. */
export function withBotChatPeople<T extends { chats: BotChatTreeChat[] }>(
  sources: BotConversationActsForSources,
  bot: Pick<Bot, 'shares'> | undefined,
  read: T
): T {
  if (!bot?.shares?.some((share) => share.kind === 'account')) {
    return read
  }
  const homes = botHomesOfChats(
    sources,
    bot,
    read.chats.map((chat) => chat.chatId)
  )
  return {
    ...read,
    chats: read.chats.map((chat) => {
      const of = homes.get(chat.chatId)
      return of && of !== 'owner' ? { ...chat, person: botChatPerson(bot, of.accountId) } : chat
    })
  }
}
