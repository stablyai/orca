// `bots.discord.*`: a bot's own Discord bot, as this host's own Orca account, for whichever of its
// clients asks. The bot's record follows each answer, so its hello lists the servers it is in.
import {
  BotDiscordBot,
  BotDiscordGuild,
  BotDiscordMembers,
  BotDiscordSetUp
} from '../../../../shared/rpc-contract/bots-connector-setup-params'
import {
  BOT_MAX_CONNECTOR_WORKSPACES,
  type Bot,
  type BotDiscord
} from '../../../../shared/bot-types'
import {
  discordBotToken,
  type ConnectorBotDiscordState,
  type ConnectorDiscordBots
} from '../../../../shared/connector-bot-discord-contract'
import { BOT_SLACK_DESKTOP_ERRORS } from '../../../../shared/connector-bot-slack-contract'
import { CONNECT_ACCOUNT_CHANGED } from '../../../connector-cloud/connector-connect'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { defineMethod } from '../core'
import { withHostCloudClient } from './bots-slack'

/**
 * The bot's Discord record after the cloud's answer: the servers it is in now, each keeping the
 * roles and channels the owner limited it to there. Undefined when nothing changes. At most
 * BOT_MAX_CONNECTOR_WORKSPACES servers are kept, those already recorded first, since a record over
 * that cap fails the bot schema and the bot would be dropped on the next load.
 */
export function nextBotDiscord(
  bot: Pick<Bot, 'discord'>,
  state: ConnectorBotDiscordState
): BotDiscord | null | undefined {
  if (state.state === 'not_created') {
    return bot.discord ? null : undefined
  }
  if (state.state === 'broken') {
    // Its servers stay listed until a new token says otherwise.
    return bot.discord?.applicationId === state.applicationId
      ? undefined
      : { applicationId: state.applicationId, guilds: [] }
  }
  const had = bot.discord?.guilds ?? []
  const recorded = (guildId: string): boolean => had.some((entry) => entry.guildId === guildId)
  const kept = [
    ...state.guilds.filter((guild) => recorded(guild.guildId)),
    ...state.guilds.filter((guild) => !recorded(guild.guildId))
  ].slice(0, BOT_MAX_CONNECTOR_WORKSPACES)
  const next: BotDiscord = {
    applicationId: state.applicationId,
    guilds: kept.map((guild) => {
      const was = had.find((entry) => entry.guildId === guild.guildId)
      return { ...was, guildId: guild.guildId, guildName: guild.name }
    })
  }
  const same =
    bot.discord?.applicationId === next.applicationId &&
    had.length === next.guilds.length &&
    had.every(
      (guild, index) =>
        guild.guildId === next.guilds[index].guildId &&
        guild.guildName === next.guilds[index].guildName
    )
  return same ? undefined : next
}

// The cloud's answer stands even if the local record cannot follow it (e.g. the bot was just deleted).
// The edit runs once earlier queued writes finish, so the account is checked there, not when queued.
async function recordDiscord(
  runtime: Pick<OrcaRuntimeService, 'bots'>,
  botId: string,
  state: ConnectorBotDiscordState,
  sameAccount: () => boolean
): Promise<void> {
  try {
    await runtime.bots.update(botId, (bot) => {
      if (!sameAccount()) {
        return {}
      }
      const discord = nextBotDiscord(bot, state)
      return discord === undefined ? {} : { discord }
    })
  } catch (error) {
    console.error('Failed to record the bot’s Discord bot:', error)
  }
}

// Each listed bot of this host follows the cloud (the list holds the whole account's); a bot it
// doesn't list keeps its record, since a removal here clears it.
async function recordDiscordBots(
  runtime: Pick<OrcaRuntimeService, 'bots'>,
  listed: ConnectorDiscordBots,
  sameAccount: () => boolean
): Promise<void> {
  const here = new Set(runtime.bots.list().map((bot) => bot.id))
  for (const { botId, ...state } of listed.bots) {
    if (here.has(botId)) {
      await recordDiscord(runtime, botId, state, sameAccount)
    }
  }
}

/**
 * Notes the host's signed-in account before a cloud call; true afterwards while it is the same. An
 * answer recorded after the account changed belongs to the old account, so each record edit asks.
 */
function sameAccountAfter(runtime: Pick<OrcaRuntimeService, 'getConnectorCloud'>): () => boolean {
  const cloud = runtime.getConnectorCloud()
  const account = cloud?.signedInAccount() ?? null
  return () => (cloud?.signedInAccount() ?? null) === account
}

// `accounts-admin`: these hold the host's integration credentials (rpc-method-permission.ts).
export const BOT_DISCORD_METHODS = [
  defineMethod({
    name: 'bots.discord.bots',
    permission: 'accounts-admin',
    params: null,
    handler: async (_params, context) => {
      const sameAccount = sameAccountAfter(context.runtime)
      const result = await withHostCloudClient(context, (client) => client.discordBots())
      if (result.ok) {
        await recordDiscordBots(context.runtime, result.value, sameAccount)
      }
      return result
    }
  }),
  defineMethod({
    name: 'bots.discord.setUp',
    permission: 'accounts-admin',
    params: BotDiscordSetUp,
    handler: async ({ botId, token }, context) => {
      const { runtime } = context
      const cloud = runtime.getConnectorCloud()
      const pasted = discordBotToken(token)
      if (pasted === null) {
        return { ok: false as const, error: 'discord_token_invalid' }
      }
      const setUp = async () => {
        const sameAccount = sameAccountAfter(runtime)
        const result = await withHostCloudClient(context, (client) =>
          client.setUpDiscordApp(botId, pasted)
        )
        if (result.ok && !sameAccount()) {
          return { ok: false as const, error: CONNECT_ACCOUNT_CHANGED }
        }
        if (result.ok && result.value.state !== 'ready') {
          return { ok: false as const, error: BOT_SLACK_DESKTOP_ERRORS.failed }
        }
        if (result.ok) {
          await recordDiscord(runtime, botId, result.value, sameAccount)
        }
        return result
      }
      // A bot with no connector yet is known to the cloud only once this host says hello.
      return cloud ? cloud.withConnection(setUp) : setUp()
    }
  }),
  defineMethod({
    name: 'bots.discord.remove',
    permission: 'accounts-admin',
    params: BotDiscordBot,
    handler: async ({ botId }, context) => {
      const sameAccount = sameAccountAfter(context.runtime)
      const removed = await withHostCloudClient(context, (client) => client.removeDiscordApp(botId))
      if (removed.ok) {
        await recordDiscord(context.runtime, botId, { state: 'not_created' }, sameAccount)
      }
      return removed
    }
  }),
  defineMethod({
    name: 'bots.discord.leaveGuild',
    permission: 'accounts-admin',
    params: BotDiscordGuild,
    handler: async ({ botId, guildId }, context) => {
      const sameAccount = sameAccountAfter(context.runtime)
      const left = await withHostCloudClient(context, (client) =>
        client.leaveDiscordGuild(botId, guildId)
      )
      if (left.ok) {
        const listed = await withHostCloudClient(context, (client) => client.discordBots())
        if (listed.ok) {
          await recordDiscordBots(context.runtime, listed.value, sameAccount)
        }
      }
      return left
    }
  }),
  defineMethod({
    name: 'bots.discord.guild',
    permission: 'accounts-admin',
    params: BotDiscordGuild,
    handler: async ({ botId, guildId }, context) =>
      withHostCloudClient(context, (client) => client.discordGuild(botId, guildId))
  }),
  defineMethod({
    name: 'bots.discord.members',
    permission: 'accounts-admin',
    params: BotDiscordMembers,
    handler: async ({ botId, guildId, query }, context) =>
      withHostCloudClient(context, (client) => client.discordMembers(botId, guildId, query))
  })
]
