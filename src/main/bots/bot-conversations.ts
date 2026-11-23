// Where a connector conversation for a bot runs: a native chat in the bot's home, while the bot takes conversations.
import type { Bot } from '../../shared/bot-types'
import { effectiveBotSetup } from '../../shared/bots/bot-backup-models'
import {
  CONNECTOR_MAX_WORK_LINKS,
  ConnectorWorkLink
} from '../../shared/connector-work-link-contract'
import { folderWorkspaceKey } from '../../shared/workspace/identity/workspace-scope'
import type { ConversationBots } from '../external-conversations/external-conversation-bots'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { runtimeBotChats, startBotSession } from './bot-chat-session'
import type { BotController } from './bot-controller'
import type { BotWorkRecord } from './bot-work-record'

export function botConversations(deps: {
  bots: Pick<BotController, 'enabled' | 'list'>
  /** The bot's Chat, created on first use. */
  ensureChat: (botId: string) => Promise<string>
  /** A new native chat in the bot's home. */
  startSession: (bot: Bot) => Promise<string>
  botWork: Pick<BotWorkRecord, 'pullRequests'>
}): ConversationBots {
  const find = (botId: string) => deps.bots.list().find((entry) => entry.id === botId)
  return {
    refusal: (botId) => {
      // Bots off: the hello lists none, and a message already in flight finds none either.
      const bot = deps.bots.enabled() ? find(botId) : undefined
      return !bot ? 'bot_not_found' : bot.paused ? 'bot_paused' : null
    },
    open: async ({ kind, botId }) => {
      const bot = find(botId)
      if (!bot) {
        throw new Error('bot_not_found')
      }
      const sessionId =
        kind === 'bot-chat' ? await deps.ensureChat(botId) : await deps.startSession(bot)
      return {
        worktreeId: folderWorkspaceKey(bot.folderWorkspaceId),
        sessionId,
        agent: effectiveBotSetup(bot).agent
      }
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
  return botConversations({
    bots: runtime.bots,
    ensureChat: chats.ensure,
    startSession: (bot) => startBotSession(runtime, bot, { background: true }),
    botWork: runtime.botWork
  })
}
