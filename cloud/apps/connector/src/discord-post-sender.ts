import { z } from 'zod'
import type { ClaimedPost } from './connector-posts.js'
import type { SendOutcome } from './post-worker.js'
import { discordRoutes, type DiscordRestApi, type DiscordResult } from './discord-rest.js'

// https://docs.discord.com/developers/topics/opcodes-and-status-codes#json-json-error-codes
const UNKNOWN_CHANNEL = '10003'
const THREAD_ALREADY_CREATED = '160004'
const THREAD_NAME = 'Orca'

const MessageBodySchema = z.object({
  content: z.string().min(1),
  components: z.array(z.unknown()).optional(),
  replyTo: z.string().min(1).optional(),
  // Set when it goes beside the message it answers rather than in the thread.
  channelId: z.string().min(1).optional()
})
const ReactionBodySchema = z.object({
  emoji: z.string().min(1),
  channelId: z.string().min(1),
  messageId: z.string().min(1)
})

// Sends one claimed post to Discord.
export class DiscordPostSender {
  constructor(private readonly deps: { botToken: string; api: DiscordRestApi }) {}

  async send(post: ClaimedPost): Promise<SendOutcome> {
    const api = (route: Parameters<DiscordRestApi>[1]) => this.deps.api(this.deps.botToken, route)
    if (post.kind === 'reaction') {
      const reaction = ReactionBodySchema.safeParse(post.body)
      return reaction.success
        ? outcome(
            await api(
              discordRoutes.addReaction(
                reaction.data.channelId,
                reaction.data.messageId,
                reaction.data.emoji
              )
            )
          )
        : { kind: 'failed' }
    }
    const parsed = MessageBodySchema.safeParse(post.body)
    // Discord has no private message outside an interaction, so nothing queues an ephemeral one.
    if (!parsed.success || post.kind === 'ephemeral') {
      return { kind: 'failed' }
    }
    const { channelId, ...message } = parsed.data
    if (post.kind === 'status' && post.messageRef !== null) {
      return outcome(await api(discordRoutes.editMessage(post.threadId, post.messageRef, message)))
    }
    // Never resent: a post left mid-send, or whose create had no clear answer, may already be in
    // the thread, so it is uncertain rather than risking a duplicate.
    if (post.stale) {
      return { kind: 'uncertain' }
    }
    const create = () => api(discordRoutes.createMessage(channelId ?? post.threadId, message))
    const created = await create()
    // A top-level mention's thread is made on Orca's first post in it.
    if (
      channelId === undefined &&
      created.kind === 'failed' &&
      created.error === UNKNOWN_CHANNEL &&
      post.threadId !== post.containerId
    ) {
      const thread = await api(
        discordRoutes.startThread(post.containerId, post.threadId, THREAD_NAME)
      )
      const started =
        thread.kind === 'ok' ||
        (thread.kind === 'failed' && thread.error === THREAD_ALREADY_CREATED)
      return started ? createdOutcome(await create()) : outcome(thread)
    }
    return createdOutcome(created)
  }
}

function createdOutcome(result: DiscordResult): SendOutcome {
  return result.kind === 'unknown' ? { kind: 'uncertain' } : outcome(result)
}

// Edits, reactions and thread starts are safe to repeat, so an unclear outcome is retried.
function outcome(result: DiscordResult): SendOutcome {
  switch (result.kind) {
    case 'ok':
      return {
        kind: 'posted',
        messageRef: typeof result.body.id === 'string' ? result.body.id : undefined
      }
    case 'failed':
      return { kind: 'failed' }
    case 'retry':
      return { kind: 'retry', afterMs: result.afterMs }
    case 'unknown':
      return { kind: 'retry' }
  }
}
