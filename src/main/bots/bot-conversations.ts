// Where a connector conversation for a bot runs: a native chat in the bot's home, while the bot takes conversations.
import { isBotAgent, type Bot } from '../../shared/bot-types'
import {
  CONNECTOR_MAX_WORK_LINKS,
  ConnectorWorkLink
} from '../../shared/connector-work-link-contract'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type {
  ConversationBots,
  ConversationChatOpening
} from '../external-conversations/external-conversation-bots'
import type { LinkableChat } from '../external-conversations/external-conversation-chat-delivery'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { forgetExpiredBotThread } from './bot-thread-expired-start'
import { runtimeBotChats, startBotSession } from './bot-chat-session'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/host/structured-agent-session-registry'
import type { BotController } from './bot-controller'
import type { BotWorkRecord } from './bot-work-record'

export function botConversations(deps: {
  bots: Pick<BotController, 'enabled' | 'list'>
  /** The bot's Chat, created on first use. */
  ensureChat: (botId: string) => Promise<string>
  /** A new native chat in the bot's home. */
  startSession: (bot: Bot, opening?: ConversationChatOpening) => Promise<LinkableChat>
  botWork: Pick<BotWorkRecord, 'pullRequests'>
}): ConversationBots {
  const find = (botId: string) => deps.bots.list().find((entry) => entry.id === botId)
  return {
    refusal: (botId) => {
      // Bots off: the hello lists none, and a message already in flight finds none either.
      const bot = deps.bots.enabled() ? find(botId) : undefined
      return !bot ? 'bot_not_found' : bot.paused ? 'bot_paused' : null
    },
    open: async ({ kind, botId }, opening) => {
      const bot = find(botId)
      if (!bot) {
        throw new Error('bot_not_found')
      }
      if (kind === 'bot-chat') {
        const sessionId = await deps.ensureChat(botId)
        return { worktreeId: folderWorkspaceKey(bot.folderWorkspaceId), sessionId, agent: bot.agent }
      }
      return deps.startSession(bot, opening)
    },
    workLinks: async ({ bot, source, externalId }) =>
      bot
        ? (
            await deps.botWork.pullRequests(
              bot.botId,
              { source, externalId },
              CONNECTOR_MAX_WORK_LINKS
            )
          ).flatMap((pr) => {
            // One link the cloud couldn't read is left out alone.
            const link = ConnectorWorkLink.safeParse({
              url: pr.url,
              title: `Pull request #${pr.number}`
            })
            return link.success ? [link.data] : []
          })
        : []
  }
}

export function runtimeBotConversations(runtime: OrcaRuntimeService): ConversationBots {
  const chats = runtimeBotChats(runtime)
  const conversations = botConversations({
    bots: runtime.bots,
    ensureChat: chats.ensure,
    startSession: async (bot, opening) => {
      const sessionId = opening?.sessionId
      const signal = opening?.signal
      if (sessionId) {
        await runtime.ensureStructuredAgentSessionHost()
        signal?.throwIfAborted()
        const existing = getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)
        if (existing) {
          if (!isBotAgent(existing.provider)) {
            throw new Error('unsupported_agent')
          }
          return {
            sessionId,
            agent: existing.provider,
            worktreeId: existing.location.workspaceId
          }
        }
      }
      await opening?.beforeCreate?.(bot.agent)
      signal?.throwIfAborted()
      const created = await startBotSession(runtime, bot, { background: true, sessionId, signal })
      return {
        sessionId: created,
        agent: bot.agent,
        worktreeId: folderWorkspaceKey(bot.folderWorkspaceId)
      }
    },
    botWork: runtime.botWork
  })
  return {
    ...conversations,
    forgetUnusedStart: (sessionId) => forgetExpiredBotThread(runtime, sessionId)
  }
}
