import type { CloudDatabase } from '@orca-cloud/cloud-database'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { ConnectorAdapter, ThreadPlace } from './connector-adapter.js'
import { noticeText, statusText } from './connector-copy.js'
import type { ConnectorCore } from './connector-core.js'
import type { DiscordConfig } from './discord-config.js'
import type { DiscordGatewayMessage } from './discord-gateway-session.js'
import { discordInteractionResponse, readDiscordInteraction } from './discord-interactions.js'
import { linkedDiscordUsers } from './discord-members.js'
import { discordNotice, messageChannel } from './discord-notices.js'
import { DiscordPostSender } from './discord-post-sender.js'
import {
  ANSWER_PREFIX,
  discordCard,
  isOpenDiscordCard,
  settledDiscordCard
} from './discord-prompt-cards.js'
import { createDiscordRestApi, discordRoutes, type DiscordRestApi } from './discord-rest.js'
import { verifyDiscordSignature } from './discord-signature.js'
import { discordText } from './discord-text.js'
import { DiscordThreadHistory } from './discord-thread-history.js'
import type { MachineEnv } from './machine-auth.js'

// Interactions are small; this only bounds what is read before the signature check.
const MAX_INTERACTION_BYTES = 64 * 1024

export type DiscordEdge = ReturnType<typeof createDiscordEdge>

// Discord in and out: the gateway worker's messages, signed answer presses, and the adapter that
// formats and sends the shared core's posts, reads threads and checks linked members.
export function createDiscordEdge(deps: {
  config: DiscordConfig
  database: CloudDatabase
  now: () => number
  api?: DiscordRestApi
}) {
  const { config, database, now } = deps
  const { botToken } = config
  const api = deps.api ?? createDiscordRestApi()
  // Read once from the API: Discord doesn't promise the bot's user id equals its application's.
  let botUser: Promise<string | null> | undefined
  const botUserId = () =>
    (botUser ??= api(botToken, discordRoutes.currentUser()).then((result) => {
      const id = result.kind === 'ok' ? result.body.id : undefined
      if (typeof id === 'string') {
        return id
      }
      botUser = undefined
      return null
    }))
  const history = new DiscordThreadHistory({ database, api, botToken, botUserId })
  const sender = new DiscordPostSender({ botToken, api })

  const adapter: ConnectorAdapter = {
    source: 'discord',
    // Posted as written; allowed_mentions keeps it from pinging anyone.
    agentText: (text) => ({ content: text }),
    notice: discordNotice,
    seen: (place, messageId) => ({
      emoji: '👀',
      channelId: messageChannel(place, messageId),
      messageId
    }),
    status: (view) => ({ content: statusText(discordText, view) }),
    card: discordCard,
    isOpenCard: isOpenDiscordCard,
    settledCard: settledDiscordCard,
    teammateContext: discordText.teammateContext,
    send: (post) => sender.send(post),
    heldStartPrompt: (start) => history.heldStartPrompt(start),
    trustedNames: async (transaction, guildId, userIds) =>
      new Map(
        [...(await linkedDiscordUsers(transaction, guildId, userIds))].map((id) => [id, null])
      )
  }

  // A message's thread: a mention in a thread, a top-level mention (its thread is made on Orca's
  // first post), or a follow-up in a thread Orca already has; null for anything else.
  async function placeOf(
    transaction: CloudDatabase,
    message: DiscordGatewayMessage
  ): Promise<ThreadPlace | null> {
    const { guildId, channelId } = message
    if (message.threadParentId !== undefined) {
      return { workspaceId: guildId, containerId: message.threadParentId, threadId: channelId }
    }
    if (message.mentioned) {
      return { workspaceId: guildId, containerId: channelId, threadId: message.messageId }
    }
    const [thread] = await transaction.query(
      `SELECT container_id FROM connector_threads
       WHERE source = 'discord' AND workspace_id = ? AND thread_id = ? LIMIT 1`,
      [guildId, channelId]
    )
    return thread
      ? { workspaceId: guildId, containerId: String(thread.container_id), threadId: channelId }
      : null
  }

  // The gateway worker's one message, in the transaction that commits its checkpoint.
  async function routeIn(
    transaction: CloudDatabase,
    core: Pick<ConnectorCore, 'routeIn'>,
    message: DiscordGatewayMessage
  ): Promise<void> {
    if (!config.guildIds.has(message.guildId)) {
      return
    }
    const place = await placeOf(transaction, message)
    if (!place) {
      return
    }
    await core.routeIn(transaction, {
      source: 'discord',
      place,
      messageId: message.messageId,
      authorId: message.userId,
      authorName: message.userName,
      text: message.text,
      mentioned: message.mentioned,
      direct: false,
      paused: config.paused
    })
  }

  // Answer presses on prompt cards: the owner's is acknowledged silently (its card edit goes
  // through the post queue); anyone else is told privately in the response.
  function registerRoutes(app: Hono<MachineEnv>, core: Pick<ConnectorCore, 'answerCard'>): void {
    app.post(
      '/discord/interactions',
      bodyLimit({
        maxSize: MAX_INTERACTION_BYTES,
        onError: (context) => context.json({ error: 'request_too_large' }, 413)
      }),
      async (context) => {
        const rawBody = await context.req.text()
        const verified = verifyDiscordSignature({
          publicKey: config.publicKey,
          timestamp: context.req.header('x-signature-timestamp'),
          signature: context.req.header('x-signature-ed25519'),
          rawBody,
          nowMs: now()
        })
        if (!verified) {
          return context.json({ error: 'invalid_signature' }, 401)
        }
        let payload: unknown
        try {
          payload = JSON.parse(rawBody)
        } catch {
          return context.json({ error: 'invalid_request' }, 400)
        }
        const interaction = readDiscordInteraction(payload)
        switch (interaction.kind) {
          case 'ping':
            return context.json(discordInteractionResponse.pong())
          case 'invalid':
          case 'ignored':
            return context.json({ error: 'invalid_request' }, 400)
        }
        const { guildId, customId } = interaction
        if (
          guildId === undefined ||
          !config.guildIds.has(guildId) ||
          !customId.startsWith(ANSWER_PREFIX)
        ) {
          return context.json(discordInteractionResponse.deferredUpdate())
        }
        const reply = await core.answerCard('discord', {
          workspaceId: guildId,
          channelId: interaction.channelId,
          messageRef: interaction.messageId,
          userId: interaction.userId,
          optionId: customId.slice(ANSWER_PREFIX.length),
          paused: config.paused
        })
        return context.json(
          reply
            ? discordInteractionResponse.ephemeral(noticeText(discordText, reply.notice))
            : discordInteractionResponse.deferredUpdate()
        )
      }
    )
  }

  return { adapter, routeIn, registerRoutes }
}
