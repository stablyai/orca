// A bot's own Discord bot, as the signed-in account sees it in Orca Cloud (discord-messages.ts in the
// cloud contract). Its token goes to the cloud once and is never read back.
import { z } from 'zod'
import {
  BOT_DISCORD_OFF,
  ConnectorBotDiscordGuildResponse,
  ConnectorBotDiscordMembersResponse,
  ConnectorBotDiscordState,
  ConnectorDiscordBots
} from '../../shared/connector-bot-discord-contract'
import type { BotSlackResult } from '../../shared/connector-bot-slack-contract'
import { CONNECTOR_PATHS } from '../../shared/connectors/connector-cloud-contract'
import { answer } from './bots-cloud-client'
import type { ConnectorCloud } from './connector-cloud'
import type { ConnectorResult } from './connector-cloud-request'

// Checking a token asks Discord for the application, its bot and its servers.
const APP_SETUP_TIMEOUT_MS = 30_000

/** As for Linear: a bare 404 is a cloud without Discord. */
export function discordAnswer<T>(result: ConnectorResult<T>): BotSlackResult<T> {
  return !result.ok && result.status === 404 && result.error === null
    ? { ok: false, error: BOT_DISCORD_OFF }
    : answer(result)
}

export function discordCloudClient(cloud: Pick<ConnectorCloud, 'call'>) {
  const botDiscord = (botId: string): string =>
    `${CONNECTOR_PATHS.bots}/${encodeURIComponent(botId)}/discord`
  const guildPath = (botId: string, guildId: string): string =>
    `${botDiscord(botId)}/guilds/${encodeURIComponent(guildId)}`
  return {
    /** The account's bots that have their own Discord bot. */
    discordBots: async () =>
      discordAnswer(
        await cloud.call(`${CONNECTOR_PATHS.discord}/bots`, undefined, ConnectorDiscordBots, {
          method: 'GET'
        })
      ),
    /** Hands the cloud the bot's Discord bot token; it answers what Discord says the token is. */
    setUpDiscordApp: async (botId: string, token: string) =>
      discordAnswer(
        await cloud.call(`${botDiscord(botId)}/app`, { v: 1, token }, ConnectorBotDiscordState, {
          timeoutMs: APP_SETUP_TIMEOUT_MS
        })
      ),
    /** Forgets the token: the Discord bot stays in its servers but stops answering. */
    removeDiscordApp: async (botId: string) =>
      discordAnswer(
        await cloud.call(botDiscord(botId), undefined, z.undefined(), { method: 'DELETE' })
      ),
    /** The Discord bot leaves that server. */
    leaveDiscordGuild: async (botId: string, guildId: string) =>
      discordAnswer(
        await cloud.call(guildPath(botId, guildId), undefined, z.undefined(), { method: 'DELETE' })
      ),
    /** The server's roles and channels, for the bot's limits there. */
    discordGuild: async (botId: string, guildId: string) =>
      discordAnswer(
        await cloud.call(guildPath(botId, guildId), undefined, ConnectorBotDiscordGuildResponse, {
          method: 'GET'
        })
      ),
    discordMembers: async (botId: string, guildId: string, query: string) =>
      discordAnswer(
        await cloud.call(
          `${botDiscord(botId)}/members?guild=${encodeURIComponent(guildId)}&q=${encodeURIComponent(query)}`,
          undefined,
          ConnectorBotDiscordMembersResponse,
          { method: 'GET' }
        )
      )
  }
}
