import type { CloudDatabase } from '@orca-cloud/cloud-database'
import { z } from 'zod'
import type { ThreadPlace } from './connector-adapter.js'
import { readDiscordMessage } from './discord-events.js'
import { linkedDiscordUsers } from './discord-members.js'
import { discordRoutes, type DiscordRestApi } from './discord-rest.js'
import { discordText } from './discord-text.js'

// Bounds on the thread a start carries: its starter plus the latest messages, each capped. One page
// of history; a longer thread still carries its latest messages.
const THREAD_PAGE_SIZE = 100
const THREAD_MAX_MESSAGES = 20
const THREAD_MAX_MESSAGE_CHARS = 2_000

const MessagesSchema = z.object({ items: z.array(z.unknown()) })

type HeldStart = { place: ThreadPlace; messageId: string; request: string }

// A held start's prompt for a mention partway through a Discord thread: the request plus the thread
// before it from linked people, labelled.
export class DiscordThreadHistory {
  constructor(
    private readonly deps: {
      database: CloudDatabase
      api: DiscordRestApi
      botToken: string
      botUserId: () => Promise<string | null>
    }
  ) {}

  async heldStartPrompt(start: HeldStart): Promise<string> {
    return discordText.threadStart(await this.threadBefore(start), start.request)
  }

  // Null when Discord couldn't be read.
  private async threadBefore(start: HeldStart): Promise<{ name: string; text: string }[] | null> {
    const { api, botToken } = this.deps
    const { workspaceId: guildId, containerId, threadId } = start.place
    const botUserId = await this.deps.botUserId()
    if (botUserId === null) {
      return null
    }
    const page = await api(
      botToken,
      discordRoutes.messagesBefore(threadId, start.messageId, THREAD_PAGE_SIZE)
    )
    const items = page.kind === 'ok' ? MessagesSchema.safeParse(page.body) : undefined
    if (!items?.success) {
      return null
    }
    // A thread made from a message starts with that message, which sits in the parent channel.
    const starter = await api(botToken, discordRoutes.message(containerId, threadId))
    const read = (payload: unknown) =>
      readDiscordMessage({ guild_id: guildId, ...asObject(payload) }, botUserId)
    const latest = items.data.items
      .map(read)
      .flatMap((message) => (message ? [message] : []))
      .toReversed()
      .slice(-(THREAD_MAX_MESSAGES - 1))
    const first = starter.kind === 'ok' ? read(starter.body) : null
    const kept = first && first.messageId !== start.messageId ? [first, ...latest] : latest
    const linked = await linkedDiscordUsers(
      this.deps.database,
      guildId,
      kept.map((message) => message.userId)
    )
    return kept.flatMap((message) => {
      const text = message.text.slice(0, THREAD_MAX_MESSAGE_CHARS)
      return linked.has(message.userId) && text.length > 0 ? [{ name: message.userName, text }] : []
    })
  }
}

function asObject(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null
    ? Object.fromEntries(Object.entries(payload))
    : {}
}
