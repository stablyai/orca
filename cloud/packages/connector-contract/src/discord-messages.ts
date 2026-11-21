import { z } from 'zod'

// Discord has no API that creates an application, so each bot's own Discord bot is one its owner
// makes in Discord's Developer Portal; Orca Cloud keeps that bot's token, encrypted, and holds its
// Gateway connection. It reads only mentions and DMs, which need no privileged intent.

// A bot token as Discord's portal shows it: three base64url parts. Discord doesn't publish a cap.
export const DISCORD_BOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/
export const DISCORD_BOT_TOKEN_MAX_LENGTH = 200

// Discord ids (snowflakes): decimal, at most 20 digits.
export const DISCORD_ID_PATTERN = /^\d{1,20}$/
const DiscordId = z.string().regex(DISCORD_ID_PATTERN)

// What the bot asks for in a server: view channels, send messages and send them in threads, attach
// files and read history (for a thread's earlier messages). Nothing that manages the server.
// Bits 10, 11, 15, 16 and 38.
export const DISCORD_BOT_PERMISSIONS = '274878008320'

// Discord's page that adds the bot to a server the person manages; `guildId` preselects one.
export function discordInviteUrl(applicationId: string, guildId?: string): string {
  const query = new URLSearchParams({
    client_id: applicationId,
    scope: 'bot',
    permissions: DISCORD_BOT_PERMISSIONS
  })
  if (guildId !== undefined) {
    query.set('guild_id', guildId)
    query.set('disable_guild_select', 'true')
  }
  return `https://discord.com/oauth2/authorize?${query.toString()}`
}

// POST `bots/<bot id>/discord/app`: the bot's Discord bot token, sent once and never read back. A new
// one replaces the last (a reset token, or another application). Answers the bot's state.
export const ConnectorBotDiscordAppRequestSchema = z.object({
  v: z.literal(1),
  token: z.string().max(DISCORD_BOT_TOKEN_MAX_LENGTH).regex(DISCORD_BOT_TOKEN_PATTERN)
})

// A server the bot is in, as Discord names it now.
export const ConnectorDiscordGuildSchema = z.object({
  guildId: DiscordId,
  name: z.string(),
  // Discord's picture of the server; left out when it has none.
  iconUrl: z.string().url().optional()
})

// - not_created: no token yet.
// - ready: the token works and the Gateway is connected; `guilds` are the servers it is in, oldest
//   first. Adding it to another goes through discordInviteUrl.
// - broken: Orca had a token Discord refuses now (token_revoked: it was reset or the application
//   deleted, so pasting a new one fixes it), or Discord stopped the Gateway (gateway_closed:
//   usually the bot is in too many servers unverified; the reason's detail is in the cloud's log).
const DiscordReady = z.object({
  state: z.literal('ready'),
  applicationId: DiscordId,
  botUserId: DiscordId,
  // The bot user's name in Discord, which people mention.
  botName: z.string(),
  // The application's owner in Discord (Discord's own record of who made it): the bot's owner there,
  // who may always ask it. Left out when a Developer Portal team owns the application, whose members are.
  ownerUserId: DiscordId.optional(),
  ownerName: z.string().optional(),
  guilds: z.array(ConnectorDiscordGuildSchema)
})
const DiscordBroken = z.object({
  state: z.literal('broken'),
  applicationId: DiscordId,
  reason: z.enum(['token_revoked', 'gateway_closed'])
})
export const ConnectorBotDiscordStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_created') }),
  DiscordReady,
  DiscordBroken
])

// GET `discord/bots`: every bot of the account that has a Discord token, as its state; a bot not
// listed has none (not_created).
export const ConnectorDiscordBotsResponseSchema = z.object({
  bots: z.array(
    z.discriminatedUnion('state', [
      DiscordReady.extend({ botId: z.string().min(1) }),
      DiscordBroken.extend({ botId: z.string().min(1) })
    ])
  )
})

// GET `bots/<bot id>/discord/members?guild=&q=`: the server's people (not bots) whose names match,
// for its Who can ask. complete is false when the server is too large to search whole.
export const ConnectorBotDiscordMembersResponseSchema = z.object({
  members: z.array(
    z.object({ id: DiscordId, name: z.string(), avatarUrl: z.string().url().optional() })
  ),
  complete: z.boolean()
})

// GET `bots/<bot id>/discord/guilds/<guild id>`: the server's roles (without @everyone and the
// roles of bots) and its text and forum channels, for limiting where and by whom the bot is asked.
export const ConnectorBotDiscordGuildResponseSchema = z.object({
  roles: z.array(z.object({ id: DiscordId, name: z.string() })),
  channels: z.array(
    z.object({ id: DiscordId, name: z.string(), kind: z.enum(['text', 'forum', 'announcement']) })
  )
})

export type ConnectorBotDiscordAppRequest = z.infer<typeof ConnectorBotDiscordAppRequestSchema>
export type ConnectorDiscordGuild = z.infer<typeof ConnectorDiscordGuildSchema>
export type ConnectorBotDiscordState = z.infer<typeof ConnectorBotDiscordStateSchema>
export type ConnectorDiscordBotsResponse = z.infer<typeof ConnectorDiscordBotsResponseSchema>
export type ConnectorBotDiscordMembersResponse = z.infer<
  typeof ConnectorBotDiscordMembersResponseSchema
>
export type ConnectorBotDiscordGuildResponse = z.infer<
  typeof ConnectorBotDiscordGuildResponseSchema
>
