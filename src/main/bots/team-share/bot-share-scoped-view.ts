// What a teammate's share connection sees through each method that names nothing, and through the reads
// of the shared bot that show less to them: the one place that decides it, so no handler hides details
// its own way.
import { getOrcaServerSignIn } from '../../orca-profiles/orca-server-sign-in'
import type { Bot } from '../../../shared/bot-types'
import { botRosterFields, type BotRosterEntry } from '../../../shared/bot-roster'
import type { BotShareScopedMethod } from '../../../shared/bots/bot-share-rpc-methods'
import type { RuntimeStatus } from '../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RpcContext } from '../../runtime/rpc/core'
import type { HostBotAgentChoices } from '../../runtime/rpc/methods/bots-agent-choices'
import { botShareListedBots } from './bot-share-access'
import { botShareChatIsTheirs, botShareReachesSession, botShareScopeOf } from './bot-share-chats'
import type { BotTools } from '../../../shared/bot-tools'
import type { BotActivityRead } from '../../../shared/bots/bot-activity-schema'
import { readBotShareActivity } from './bot-share-activity'
import type { ConnectorLinearState } from '../../../shared/connector-bot-linear-contract'
import type { ConnectorGitHubState } from '../../../shared/connector-bot-github-contract'
import type { GoogleStatusView } from '../../../shared/google/google-connect-types'
import type { ConnectorBotSlackStateResponse } from '../../../shared/connector-bot-slack-contract'
import type { ComposioStatus } from '../../../shared/composio/composio-apps'
import {
  botShareComposioStatus,
  botShareSlackState,
  botShareGitHubState,
  botShareGoogleStatus,
  botShareLinearState,
  botShareTools
} from './bot-share-connector-views'

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
  /** By session id: any chat of the shared agent. */
  'agentSession.subscribeStatus': (sessionId: string) => boolean
  /** The protocol and capabilities a teammate's Orca checks; nothing of the owner's computer. */
  'status.get': (status: RuntimeStatus) => RuntimeStatus
  /** The host account's Linear and GitHub links, without install links or other agents' ids. */
  'bots.linear.state': (state: ConnectorLinearState) => ConnectorLinearState
  'bots.github.state': (state: ConnectorGitHubState) => ConnectorGitHubState
  /** Read as the shared bot reads it (its own accounts), without the app's key; `view` strips the rest. */
  'google.status': { bot: Bot | null; view: (view: GoogleStatusView) => GoogleStatusView }
  /** By bot: the teammate's own Activity, built from their chats alone. */
  'bots.activity': () => Promise<BotActivityRead>
  /** By bot: the shared bot's Slack and Composio, read as their allowlisted views. */
  'bots.slack.state': (state: ConnectorBotSlackStateResponse) => ConnectorBotSlackStateResponse
  'bots.composio.status': (status: ComposioStatus) => ComposioStatus
  /** By bot: the shared bot's tools by name, never their URL or command line. */
  'bots.tools.list': (tools: BotTools) => BotTools
}>

/** The owner as this host's Orca sign-in names them; null signed out. */
export function hostOwnerName(): string | null {
  const account = getOrcaServerSignIn()?.status()
  return account?.state === 'signed-in' ? (account.displayName ?? account.email ?? null) : null
}

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
    'bots.list': (bots) => botShareListedBots(bots, scope, hostOwnerName()),
    // Built from the listed bot, so it links nowhere and reads no SOUL.md, chats or other computers.
    'bots.roster': () =>
      botShareListedBots(runtime.bots.list(), scope).map((bot) => ({
        ...botRosterFields(bot),
        specialty: null
      })),
    'bots.chats.own': {
      botIds: [scope.botId],
      owns: botShareChatIsTheirs(runtime, scope),
      home: { accountId: scope.accountId }
    },
    'bots.agentChoices': ({ newChatAgents }) => ({ newChatAgents }),
    'agentSession.subscribeStatus': (sessionId) =>
      botShareReachesSession(runtime, scope, sessionId),
    'status.get': botShareStatus,
    'bots.linear.state': (state) => botShareLinearState(state, scope.botId),
    'bots.github.state': (state) => botShareGitHubState(state, scope.botId),
    'google.status': sharedGoogleStatus(runtime.bots.list(), scope.botId),
    'bots.activity': () => readBotShareActivity(runtime, scope),
    'bots.slack.state': botShareSlackState,
    'bots.composio.status': botShareComposioStatus,
    'bots.tools.list': botShareTools
  }
}

function sharedGoogleStatus(
  bots: readonly Bot[],
  botId: string
): BotShareScopedView['google.status'] {
  const bot = bots.find((entry) => entry.id === botId) ?? null
  return { bot, view: (view) => (bot ? botShareGoogleStatus(view, bot) : view) }
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
