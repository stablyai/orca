// What a teammate's share connection sees through each method that names nothing: the one place that
// decides it, so no handler hides details its own way.
import type { Bot } from '../../../shared/bot-types'
import { botRosterFields, type BotRosterEntry } from '../../../shared/bot-roster'
import type { BotShareScopedMethod } from '../../../shared/bots/bot-share-rpc-methods'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RpcContext } from '../../runtime/rpc/core'
import type { HostBotAgentChoices } from '../../runtime/rpc/methods/bots-agent-choices'
import { botShareListedBots } from './bot-share-access'
import { botShareChatFilter, botShareScopeOf, botShareSessionFilter } from './bot-share-chats'

type EveryScopedMethod<T extends Record<BotShareScopedMethod, unknown>> = T

export type BotShareScopedView = EveryScopedMethod<{
  'bots.list': (bots: readonly Bot[]) => Bot[]
  'bots.roster': () => BotRosterEntry[]
  /** The shared agent's chats, kept by chat id (its /clear root); their own Home is read elsewhere. */
  'bots.chats.own': {
    botIds: [string]
    owns: (chatId: string) => boolean
    home: { accountId: string }
  }
  /** The agents the owner's + menu offers for a new chat; not those New bot offers. */
  'bots.agentChoices': (choices: HostBotAgentChoices) => Pick<HostBotAgentChoices, 'newChatAgents'>
  /** By session id; one per stream, as it keeps the answers it has given. */
  'agentSession.subscribeStatus': (sessionId: string) => boolean
  /** The protocol and capabilities a teammate's Orca checks; nothing of the owner's computer. */
  'status.get': (status: RuntimeStatus) => RuntimeStatus
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
    'bots.chats.own': {
      botIds: [scope.botId],
      owns: botShareChatFilter(runtime, scope),
      home: { accountId: scope.accountId }
    },
    'bots.agentChoices': ({ newChatAgents }) => ({ newChatAgents }),
    'agentSession.subscribeStatus': botShareSessionFilter(runtime, scope),
    'status.get': botShareStatus
  }
}

function botShareStatus(status: RuntimeStatus): RuntimeStatus {
  return {
    runtimeId: status.runtimeId,
    rendererGraphEpoch: status.rendererGraphEpoch,
    graphStatus: status.graphStatus,
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    runtimeProtocolVersion: status.runtimeProtocolVersion,
    minCompatibleRuntimeClientVersion: status.minCompatibleRuntimeClientVersion,
    capabilities: status.capabilities,
    appVersion: status.appVersion,
    protocolVersion: status.protocolVersion,
    minCompatibleMobileVersion: status.minCompatibleMobileVersion
  }
}
