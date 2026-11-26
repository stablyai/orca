import { createHash } from 'node:crypto'
import { BoundedMap } from '../../shared/collections/bounded-map'
import {
  botGroupPageReply,
  type BotGroup,
  type BotGroupMessage,
  type BotGroupTurn
} from '../../shared/bots/bot-group'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../shared/remote-runtime/remote-runtime-memory-limits'
import { botGroupTurnEnd, settledGroupRoomReply } from './bot-group-turn-end'

// Full reads and deltas share a page boundary. Leave room for the transport envelope.
const PAGE_ENVELOPE_BYTES = 64 * 1024
const CUT = '…'

type ReplyPreview = { source: string; reply: string; key: string; bytes: number }
const replyPreviews = new BoundedMap<string, ReplyPreview>({
  maxEntries: 4_096,
  maxBytes: 24 * 1024 * 1024,
  sizeOf: ({ source, reply }) => (source.length + reply.length) * 2 + 128
})

function preview(turn: BotGroupTurn, source: string): ReplyPreview {
  const cached = replyPreviews.get(turn.operationId)
  if (cached?.source === source) {
    return cached
  }
  const reply = botGroupPageReply(source)
  const serialized = JSON.stringify(reply)
  const next = {
    source,
    reply,
    key: createHash('sha256').update(serialized).digest('base64url'),
    bytes: Buffer.byteLength(serialized) + ',"reply":'.length
  }
  replyPreviews.set(turn.operationId, next)
  return next
}

type PagePost = {
  post: BotGroupMessage
  previews: ReadonlyMap<string, Pick<ReplyPreview, 'reply' | 'key' | 'bytes'>>
  bytes: number
  previewBytes: number
}

const pagePosts = new WeakMap<BotGroupMessage, PagePost>()
const previewBytesByKey = new BoundedMap<string, number>({ maxEntries: 4_096 })

/** Cache room previews independently of the larger reply text used by delivery and quoting. */
export function projectBotGroupRoomPost(message: BotGroupMessage): BotGroupMessage {
  return {
    ...message,
    turns: message.turns.map(({ turnItemId: _turnItemId, roomReply, ...record }, index) => {
      const { frozenItems } = record
      const turn =
        frozenItems !== undefined
          ? {
              ...record,
              ...botGroupTurnEnd(frozenItems),
              frozenHistory: true as const,
              frozenItems: undefined,
              workerDispatchIds: undefined
            }
          : record
      const source =
        roomReply ??
        (typeof turn.reply === 'string' ? turn.reply : undefined) ??
        (frozenItems ? settledGroupRoomReply(frozenItems) : undefined)
      if (typeof source !== 'string') {
        return turn
      }
      const saved = preview(message.turns[index], source)
      previewBytesByKey.set(saved.key, saved.bytes)
      return { ...turn, reply: saved.reply, replyKey: saved.key }
    })
  }
}

function projectPost(message: BotGroupMessage): PagePost {
  const cached = pagePosts.get(message)
  if (cached) {
    return cached
  }
  const previews = new Map<string, Pick<ReplyPreview, 'reply' | 'key' | 'bytes'>>()
  const turns = message.turns.map((turn) => {
    if (typeof turn.reply !== 'string' || !turn.replyKey) {
      return turn
    }
    previews.set(turn.operationId, {
      reply: turn.reply,
      key: turn.replyKey,
      bytes:
        previewBytesByKey.get(turn.replyKey) ??
        Buffer.byteLength(JSON.stringify(turn.reply)) + ',"reply":'.length
    })
    return { ...turn, reply: undefined }
  })
  const post = { ...message, turns }
  const bytes = Buffer.byteLength(JSON.stringify(post)) + 1
  const previewBytes = [...previews.values()].reduce((total, reply) => total + reply.bytes, 0)
  const projected = { post, previews, bytes, previewBytes }
  pagePosts.set(message, projected)
  return projected
}

/** Keep recent page boundaries stable, then use remaining wire space for named updates. */
export function presentBotGroupPage(
  group: BotGroup,
  messages: readonly BotGroupMessage[],
  knownReplyKeys: readonly string[] | undefined,
  recentIds: ReadonlySet<string>
): BotGroupMessage[] {
  const known = new Set(knownReplyKeys)
  const page: BotGroupMessage[] = []
  let remaining =
    REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES -
    PAGE_ENVELOPE_BYTES -
    Buffer.byteLength(JSON.stringify(group))
  let recentRemaining = remaining
  for (const message of messages.toReversed()) {
    const recent = recentIds.has(message.id)
    if (recent && page.length && recentRemaining <= 0) {
      continue
    }
    const { post, previews, bytes, previewBytes } = projectPost(message)
    const reserved = bytes + previewBytes
    if (recent && page.length && reserved > recentRemaining) {
      recentRemaining = 0
      continue
    }
    const wireBytes = [...previews.values()].reduce(
      (total, reply) => (known.has(reply.key) ? total : total + reply.bytes),
      bytes
    )
    if (!recent && wireBytes > remaining) {
      continue
    }
    const budget = recent ? recentRemaining : remaining
    let available = budget - bytes
    page.push(
      previews.size === 0
        ? post
        : {
            ...post,
            turns: post.turns.map((turn) => {
              const saved = previews.get(turn.operationId)
              if (!saved) {
                return turn
              }
              if (known.has(saved.key) && !recent) {
                return turn
              }
              if (saved.bytes > available) {
                return { ...turn, replyKey: undefined, reply: CUT }
              }
              available -= saved.bytes
              return known.has(saved.key)
                ? turn
                : { ...turn, replyKey: knownReplyKeys ? saved.key : undefined, reply: saved.reply }
            })
          }
    )
    remaining -= wireBytes
    if (recent) {
      recentRemaining -= reserved
    }
  }
  return page.toReversed()
}
