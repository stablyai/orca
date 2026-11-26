// Which of a shared bot's chats are a teammate's own: the only chats their share connection lists, reads
// or acts in. Others' chats are not theirs to see, Home Chat included.
import type { BotRequestPerson } from '../../../shared/bots/bot-acts-for'
import { actsForOwner, shareOwnsChat } from '../../../shared/bots/bot-acts-for'
import type { BotShareCallerScope } from '../../runtime/rpc/callers/rpc-caller-scope'
import type { RpcContext } from '../../runtime/rpc/core'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { createChatOrcaSessionIdResolver } from '../../runtime/orchestration/addressing/session-lineage/canonical-orca-session-id'
import { botOfSession } from '../bot-session-tabs'
import {
  readBotConversationActsFor,
  type BotConversationActsForSources
} from '../bot-conversation-acts-for'

type BotShareChatSources = BotConversationActsForSources & Pick<OrcaRuntimeService, 'bots'>

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

/** Whether a session is one of the teammate's chats on the shared bot. */
export function botShareOwnsSession(
  sources: BotShareChatSources,
  scope: BotShareCallerScope,
  sessionId: string
): boolean {
  return (
    botOfSession(sources.bots, sessionId)?.id === scope.botId &&
    botShareChatFilter(sources, scope)(createChatOrcaSessionIdResolver()(sessionId))
  )
}

/** `botShareOwnsSession` for a stream that asks again on every event: a chat once theirs stays theirs
 *  (whom a chat acts for never changes), so only those answers are kept. */
export function botShareSessionFilter(
  sources: BotShareChatSources,
  scope: BotShareCallerScope
): (sessionId: string) => boolean {
  const theirs = new Set<string>()
  return (sessionId) => {
    if (theirs.has(sessionId)) {
      return true
    }
    const owned = botShareOwnsSession(sources, scope, sessionId)
    if (owned) {
      theirs.add(sessionId)
    }
    return owned
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
