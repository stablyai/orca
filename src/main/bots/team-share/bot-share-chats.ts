// A teammate's chats on a shared bot: they reach every one of its chats (teammate-rules.ts, rule 1);
// whose a chat is (whom it acts for) decides only how it lists, never whether they may read it.
import type { BotRequestPerson } from '../../../shared/bots/bot-acts-for'
import { actsForOwner, shareOwnsChat } from '../../../shared/bots/bot-acts-for'
import type { Bot } from '../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../shared/bots/bot-chat-tree'
import { botChatPerson } from '../../../shared/bots/bot-chat-people'
import { botSharePersonName } from '../../../shared/bots/bot-home-of'
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

/** Whom a teammate's new chat acts for: them, as their share row names them now, never the owner. */
export function botShareAsker(
  bot: Pick<Bot, 'shares'>,
  scope: BotShareCallerScope
): BotRequestPerson {
  return {
    kind: 'person',
    source: 'orca',
    userId: scope.accountId,
    name: botSharePersonName(bot, scope.accountId),
    workspaceId: null,
    role: 'member'
  }
}

/** A chat a teammate creates in their agent's Home is theirs: whom it acts for is written as it is
 *  created, the one stamp its tab's person is read from (`chatTabPerson`). Written once; an existing
 *  record (a Home Chat's, a New chat's) wins. */
export async function stampTeammateHomeChat(
  context: Pick<RpcContext, 'callerScope' | 'runtime'>,
  worktreeSelector: string,
  sessionId: string
): Promise<void> {
  const scope = botShareScopeOf(context)
  const bot = scope && context.runtime.bots.list().find((entry) => entry.id === scope.botId)
  if (scope && bot && (await context.runtime.namesTeammateHome(worktreeSelector, scope))) {
    context.runtime
      .getOrchestrationDb()
      .recordBotConversationActsFor(sessionId, { actsFor: [botShareAsker(bot, scope)] })
  }
}

/** By chat id (its /clear root): the teammate's own when Orca's record says it acts for them alone.
 *  Whose, not access: it lists their own chats first, never hides another's. */
export function botShareChatIsTheirs(
  sources: BotConversationActsForSources,
  scope: BotShareCallerScope
): (chatId: string) => boolean {
  return (chatId) => {
    const recorded = readBotConversationActsFor(sources, chatId)
    return recorded !== undefined && shareOwnsChat(recorded.actsFor, scope.accountId)
  }
}

/** Whether a teammate reaches a session: any chat of the shared bot, whoever it is for (rule 1). */
export function botShareReachesSession(
  sources: Pick<OrcaRuntimeService, 'bots'>,
  scope: BotShareCallerScope,
  sessionId: string
): boolean {
  return botOfSession(sources.bots, sessionId)?.id === scope.botId
}

/** Whose empty chat New chat may open again: for the owner, theirs (or one Orca never recorded, as
 *  chats from before records were kept); for a teammate, their own. Never anyone else's. */
export function emptyChatReusableBy(
  sources: BotConversationActsForSources,
  scope: BotShareCallerScope | null
): (chatId: string) => boolean {
  const teammates = scope ? botShareChatIsTheirs(sources, scope) : null
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
