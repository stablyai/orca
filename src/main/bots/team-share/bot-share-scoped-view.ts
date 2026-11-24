// What a teammate's share connection sees through each method that names nothing: the one place that
// decides it, so no handler hides details its own way.
import type { Bot } from '../../../shared/bot-types'
import { botRosterFields, type BotRosterEntry } from '../../../shared/bot-roster'
import type { BotShareScopedMethod } from '../../../shared/bots/bot-share-rpc-methods'
import type { RpcContext } from '../../runtime/rpc/core'
import { botShareListedBots } from './bot-share-access'
import { botShareChatFilter, botShareScopeOf, botShareSessionFilter } from './bot-share-chats'

type EveryScopedMethod<T extends Record<BotShareScopedMethod, unknown>> = T

export type BotShareScopedView = EveryScopedMethod<{
  'bots.list': (bots: readonly Bot[]) => Bot[]
  'bots.roster': () => BotRosterEntry[]
  /** The shared bot's chats, kept by chat id (its /clear root). */
  'bots.chats.own': { botIds: [string]; owns: (chatId: string) => boolean }
  /** By session id; one per stream, as it keeps the answers it has given. */
  'agentSession.subscribeStatus': (sessionId: string) => boolean
}>

/** The teammate's view, or null for any other caller (who sees the handler's full answer). */
export function botShareScopedView(
  context: Pick<RpcContext, 'callerScope' | 'runtime'>
): BotShareScopedView | null {
  const scope = botShareScopeOf(context)
  if (!scope) {
    return null
  }
  const { runtime } = context
  return {
    'bots.list': (bots) => botShareListedBots(bots, scope),
    // Built from the listed bot, so it links nowhere and reads no SOUL.md, chats or other computers.
    'bots.roster': () =>
      botShareListedBots(runtime.bots.list(), scope).map((bot) => ({
        ...botRosterFields(bot),
        specialty: null
      })),
    'bots.chats.own': { botIds: [scope.botId], owns: botShareChatFilter(runtime, scope) },
    'agentSession.subscribeStatus': botShareSessionFilter(runtime, scope)
  }
}
