import { z } from 'zod'

// https://docs.discord.com/developers/interactions/receiving-and-responding
const PING = 1
const MESSAGE_COMPONENT = 3
const EPHEMERAL = 1 << 6

const UserSchema = z.looseObject({ id: z.string().min(1) })

const InteractionSchema = z.looseObject({
  type: z.number().int(),
  guild_id: z.string().min(1).optional(),
  channel_id: z.string().min(1).optional(),
  // A guild interaction names its user under member; a DM one under user.
  member: z.looseObject({ user: UserSchema }).optional(),
  user: UserSchema.optional(),
  data: z.looseObject({}).optional(),
  message: z.looseObject({ id: z.string().min(1) }).optional()
})

const ComponentDataSchema = z.looseObject({
  custom_id: z.string().min(1).max(100),
  component_type: z.number().int()
})

type InteractionBase = {
  guildId?: string
  channelId: string
  userId: string
}

export type DiscordInteraction =
  | { kind: 'ping' }
  | (InteractionBase & { kind: 'component'; customId: string; messageId: string })
  | { kind: 'ignored' }
  | { kind: 'invalid' }

export function readDiscordInteraction(payload: unknown): DiscordInteraction {
  const parsed = InteractionSchema.safeParse(payload)
  if (!parsed.success) {
    return { kind: 'invalid' }
  }
  const interaction = parsed.data
  if (interaction.type === PING) {
    return { kind: 'ping' }
  }
  const userId = interaction.member?.user.id ?? interaction.user?.id
  if (userId === undefined || interaction.channel_id === undefined) {
    return { kind: 'ignored' }
  }
  const base: InteractionBase = {
    ...(interaction.guild_id === undefined ? {} : { guildId: interaction.guild_id }),
    channelId: interaction.channel_id,
    userId
  }
  if (interaction.type === MESSAGE_COMPONENT) {
    const data = ComponentDataSchema.safeParse(interaction.data)
    return data.success && interaction.message
      ? {
          ...base,
          kind: 'component',
          customId: data.data.custom_id,
          messageId: interaction.message.id
        }
      : { kind: 'invalid' }
  }
  return { kind: 'ignored' }
}

// Callback bodies returned as the HTTP response; our text never pings anyone.
export const discordInteractionResponse = {
  pong: () => ({ type: 1 }),
  // Seen only by the person who clicked.
  ephemeral: (content: string) => ({
    type: 4,
    data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } }
  }),
  // Acknowledges a click without a loading state; the card edit goes through the post queue.
  deferredUpdate: () => ({ type: 6 })
}
