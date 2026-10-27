import { z } from 'zod'
import { discordPromptText } from './discord-text.js'

// Gateway dispatch shapes: https://docs.discord.com/developers/events/gateway-events and the
// message object in https://docs.discord.com/developers/resources/message.
const MessageCreateSchema = z.looseObject({
  id: z.string().min(1),
  channel_id: z.string().min(1),
  guild_id: z.string().min(1).optional(),
  author: z.looseObject({
    id: z.string().min(1),
    bot: z.boolean().optional(),
    username: z.string().optional(),
    global_name: z.string().nullish()
  }),
  member: z.looseObject({ nick: z.string().nullish() }).optional(),
  content: z.string(),
  mentions: z.array(z.looseObject({ id: z.string() })).default([]),
  type: z.number().int(),
  webhook_id: z.string().optional()
})
// DEFAULT and REPLY; joins, pins, thread notices and command echoes are not a person's message.
const PERSON_MESSAGE_TYPES = new Set([0, 19])

export type DiscordMessage = {
  guildId: string
  channelId: string
  messageId: string
  userId: string
  // The server nickname, else the display name, else the username.
  userName: string
  // What the agent reads: the bot's mention dropped.
  text: string
  mentioned: boolean
}

// A guild member's message, or null for DMs, bots, webhooks, ourselves and system messages.
export function readDiscordMessage(payload: unknown, botUserId: string): DiscordMessage | null {
  const parsed = MessageCreateSchema.safeParse(payload)
  if (!parsed.success) {
    return null
  }
  const message = parsed.data
  if (
    message.guild_id === undefined ||
    message.author.bot === true ||
    message.webhook_id !== undefined ||
    message.author.id === botUserId ||
    !PERSON_MESSAGE_TYPES.has(message.type)
  ) {
    return null
  }
  return {
    guildId: message.guild_id,
    channelId: message.channel_id,
    messageId: message.id,
    userId: message.author.id,
    userName:
      message.member?.nick ||
      message.author.global_name ||
      message.author.username ||
      message.author.id,
    text: discordPromptText(message.content, botUserId),
    mentioned: message.mentions.some((user) => user.id === botUserId)
  }
}

const ChannelSchema = z.looseObject({
  type: z.number().int(),
  parent_id: z.string().nullable().optional()
})
// Announcement, public and private threads; https://docs.discord.com/developers/resources/channel
const THREAD_TYPES = new Set([10, 11, 12])

// A channel object's parent when it is a thread, else null; undefined when it can't be read.
export function threadParentOf(channel: unknown): string | null | undefined {
  const parsed = ChannelSchema.safeParse(channel)
  if (!parsed.success) {
    return undefined
  }
  const { type, parent_id: parentId } = parsed.data
  return THREAD_TYPES.has(type) && parentId ? parentId : null
}
