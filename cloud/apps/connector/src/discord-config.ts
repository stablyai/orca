import type { KeyObject } from 'node:crypto'
import { z } from 'zod'
import { decodeDiscordPublicKey } from './discord-signature.js'

export type DiscordConfig = {
  // Verifies interaction requests.
  publicKey: KeyObject
  // One Orca bot for every server: the gateway session and all REST calls use it.
  botToken: string
  // Messages and clicks from any other server are acknowledged and ignored.
  guildIds: ReadonlySet<string>
  // Cloud-wide kill switch: ingress still answers but queues nothing.
  paused: boolean
}

const DiscordEnvSchema = z.object({
  ORCA_CONNECTOR_DISCORD_PUBLIC_KEY: z.string().min(1).optional(),
  ORCA_CONNECTOR_DISCORD_BOT_TOKEN: z.string().min(1).optional(),
  ORCA_CONNECTOR_DISCORD_GUILD_IDS: z.string().min(1).optional(),
  ORCA_CONNECTOR_DISCORD_PAUSED: z.enum(['true', 'false']).default('false')
})

// Discord is off without a public key; with one, the bot token and allowlist are required.
export function parseDiscordConfig(
  env: Record<string, string | undefined>
): DiscordConfig | undefined {
  const parsed = DiscordEnvSchema.parse(env)
  const publicKey = parsed.ORCA_CONNECTOR_DISCORD_PUBLIC_KEY
  if (publicKey === undefined) {
    return undefined
  }
  const guildIds = (parsed.ORCA_CONNECTOR_DISCORD_GUILD_IDS ?? '')
    .split(',')
    .map((guild) => guild.trim())
    .filter((guild) => guild.length > 0)
  const botToken = parsed.ORCA_CONNECTOR_DISCORD_BOT_TOKEN
  if (guildIds.length === 0 || botToken === undefined) {
    throw new Error(
      'Discord needs ORCA_CONNECTOR_DISCORD_BOT_TOKEN and ORCA_CONNECTOR_DISCORD_GUILD_IDS'
    )
  }
  return {
    publicKey: decodeDiscordPublicKey(publicKey),
    botToken,
    guildIds: new Set(guildIds),
    paused: parsed.ORCA_CONNECTOR_DISCORD_PAUSED === 'true'
  }
}
