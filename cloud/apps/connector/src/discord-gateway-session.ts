import { REST } from '@discordjs/rest'
import { CloseCodes, WebSocketManager, WebSocketShardEvents, type SessionInfo } from '@discordjs/ws'
import { z } from 'zod'
import { readDiscordMessage, threadParentOf, type DiscordMessage } from './discord-events.js'
import { discordRoutes, type DiscordRestApi } from './discord-rest.js'

// GUILDS, GUILD_MESSAGES, MESSAGE_CONTENT (privileged).
// https://docs.discord.com/developers/events/gateway
export const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15)
// Bad token, shard, version or intents: the library stops, and so should the worker.
// https://docs.discord.com/developers/topics/opcodes-and-status-codes
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014])
// A channel that is gone or out of reach never will be: its message is skipped, not retried.
const TERMINAL_LOOKUP_STATUSES = new Set([403, 404])
const MAX_REMEMBERED_CHANNELS = 10_000

const ReadySchema = z.looseObject({ session_id: z.string().min(1), resume_gateway_url: z.string() })

// Where a new leader resumes: the session and the last dispatch committed with its effects.
export type GatewayCheckpoint = { sessionId: string; resumeURL: string; sequence: number }

// threadParentId: set when a mention's channel is a thread.
export type DiscordGatewayMessage = DiscordMessage & { threadParentId?: string }

// One dispatch: the message it carries, if any, and the checkpoint just past it.
export type GatewayStep = { checkpoint: GatewayCheckpoint; message: DiscordGatewayMessage | null }

export type DiscordGatewaySession = {
  // Closes resumably; the next leader resumes from the committed checkpoint. A shutdown that still
  // leads drains what is queued; one that lost leadership drops it.
  close(options: { drain: boolean }): Promise<void>
}

// One gateway session (one shard) through @discordjs/ws, which owns identify, heartbeat, resume
// and reconnects. Dispatches are committed one at a time, in order; a failed one ends the session
// so the next leader replays it from the last committed checkpoint.
export async function startDiscordGatewaySession(deps: {
  token: string
  // Bounded, single-attempt reads, so a rate limit fails a dispatch instead of stalling the queue.
  api: DiscordRestApi
  guildIds: ReadonlySet<string>
  resumeFrom: GatewayCheckpoint | null
  commit: (step: GatewayStep) => Promise<void>
  // Discord refused the session, or a dispatch couldn't be committed; the worker exits.
  onFatal: (reason: string) => void
  // Gateway discovery for the library; tests point it at a fake.
  rest?: REST
}): Promise<DiscordGatewaySession> {
  const read = (route: Parameters<DiscordRestApi>[1]) => deps.api(deps.token, route)
  // A resumed session gets no READY, so the bot's own id comes from the API.
  const me = await read(discordRoutes.currentUser())
  const botUserId = me.kind === 'ok' ? me.body.id : undefined
  if (typeof botUserId !== 'string') {
    throw new Error('Discord did not return the bot user')
  }
  const { resumeFrom } = deps
  // The library's own resume state, in memory; the committed checkpoint is what survives a crash.
  let session: SessionInfo | null = resumeFrom && { ...resumeFrom, shardId: 0, shardCount: 1 }
  let current = resumeFrom
  // Thread parents already looked up (null: not a thread), oldest forgotten first.
  const parents = new Map<string, string | null>()
  // A dispatch that failed stops the rest of its session; the next leader replays from before it.
  let failedSession: string | null = null
  let dropQueued = false
  let committing = Promise.resolve()

  // A mention's channel is looked up once; null skips a channel that is gone or out of reach.
  const withParent = async (message: DiscordMessage): Promise<DiscordGatewayMessage | null> => {
    if (!message.mentioned) {
      return message
    }
    if (!parents.has(message.channelId)) {
      const channel = await read(discordRoutes.channel(message.channelId))
      if (channel.kind === 'failed' && TERMINAL_LOOKUP_STATUSES.has(channel.status)) {
        console.warn(
          JSON.stringify({
            event: 'orca_connector_discord_channel_unreachable',
            status: channel.status
          })
        )
        return null
      }
      const parent = channel.kind === 'ok' ? threadParentOf(channel.body) : undefined
      if (parent === undefined) {
        throw new Error('Discord channel lookup failed')
      }
      parents.set(message.channelId, parent)
      if (parents.size > MAX_REMEMBERED_CHANNELS) {
        parents.delete(parents.keys().next().value ?? '')
      }
    }
    const threadParentId = parents.get(message.channelId)
    return typeof threadParentId === 'string' ? { ...message, threadParentId } : message
  }

  const manager = new WebSocketManager({
    token: deps.token,
    intents: DISCORD_GATEWAY_INTENTS,
    rest: (deps.rest ?? new REST()).setToken(deps.token),
    shardCount: 1,
    identifyProperties: {
      os: process.platform,
      browser: 'orca-connector',
      device: 'orca-connector'
    },
    retrieveSessionInfo: () => session,
    updateSessionInfo: (_shardId, info) => {
      session = info
    }
  })
  manager.on(WebSocketShardEvents.Dispatch, (payload) => {
    if (payload.t === 'READY') {
      const ready = ReadySchema.parse(payload.d)
      if (current !== null) {
        // A refused resume: the dispatches in between are lost.
        console.warn(JSON.stringify({ event: 'orca_connector_discord_gateway_fresh_session' }))
      }
      current = { sessionId: ready.session_id, resumeURL: ready.resume_gateway_url, sequence: 0 }
    }
    if (current === null) {
      return
    }
    const checkpoint = { ...current, sequence: payload.s }
    current = checkpoint
    const parsed = payload.t === 'MESSAGE_CREATE' ? readDiscordMessage(payload.d, botUserId) : null
    // Other servers' messages are only checkpointed, never looked up.
    const message = parsed && deps.guildIds.has(parsed.guildId) ? parsed : null
    // A fresh READY ends the older session: what is still queued from it is dropped.
    const obsolete = () => checkpoint.sessionId !== current?.sessionId
    committing = committing.then(async () => {
      if (dropQueued || obsolete() || failedSession === checkpoint.sessionId) {
        return
      }
      try {
        await deps.commit({ checkpoint, message: message && (await withParent(message)) })
      } catch {
        if (obsolete()) {
          return
        }
        failedSession = checkpoint.sessionId
        console.warn(JSON.stringify({ event: 'orca_connector_discord_dispatch_failed' }))
        deps.onFatal('dispatch_failed')
      }
    })
  })
  manager.on(WebSocketShardEvents.Closed, (code) => {
    if (FATAL_CLOSE_CODES.has(code)) {
      console.warn(JSON.stringify({ event: 'orca_connector_discord_gateway_fatal', code }))
      deps.onFatal(`close_${code}`)
    }
  })
  manager.on(WebSocketShardEvents.Error, () => {
    console.warn(JSON.stringify({ event: 'orca_connector_discord_gateway_error' }))
  })
  await manager.connect()
  return {
    close: async ({ drain }) => {
      dropQueued = !drain
      await manager.destroy({ code: CloseCodes.Resuming })
      await committing
    }
  }
}
