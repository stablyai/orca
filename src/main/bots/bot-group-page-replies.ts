import { createHash } from 'node:crypto'
import { BoundedMap } from '../../shared/collections/bounded-map'
import {
  botGroupPageReply,
  type BotGroup,
  type BotGroupMessage,
  type BotGroupTurn
} from '../../shared/bots/bot-group'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../shared/remote-runtime/remote-runtime-memory-limits'

// Full reads and deltas share a page boundary. Leave room for the transport envelope.
const PAGE_ENVELOPE_BYTES = 64 * 1024
const CUT = '…'

type ReplyPreview = { source: string; fence?: string; reply: string; key: string; bytes: number }
const replyPreviews = new BoundedMap<string, ReplyPreview>({
  maxEntries: 4_096,
  maxBytes: 64 * 1024 * 1024,
  sizeOf: ({ source, reply }) => (source.length + reply.length) * 2 + 128
})

function preview(turn: BotGroupTurn, source: string): ReplyPreview {
  const cached = replyPreviews.get(turn.operationId)
  if (cached?.source === source && cached.fence === turn.replyFence) {
    return cached
  }
  const reply = botGroupPageReply(source, turn.replyFence)
  const serialized = JSON.stringify(reply)
  const next = {
    source,
    fence: turn.replyFence,
    reply,
    key: createHash('sha256').update(serialized).digest('base64url'),
    bytes: Buffer.byteLength(serialized) + ',"reply":'.length
  }
  replyPreviews.set(turn.operationId, next)
  return next
}

type PagePost = {
  post: BotGroupMessage
  previews: ReadonlyMap<string, ReplyPreview>
  bytes: number
}

const pagePosts = new WeakMap<BotGroupMessage, PagePost>()

function projectPost(message: BotGroupMessage): PagePost {
  const cached = pagePosts.get(message)
  if (cached) {
    return cached
  }
  const previews = new Map<string, ReplyPreview>()
  const turns = message.turns.map(
    ({ turnItemId: _turnItemId, replyFence: _replyFence, ...turn }, index) => {
      if (typeof turn.reply !== 'string') {
        return turn
      }
      const saved = preview(message.turns[index], turn.reply)
      previews.set(turn.operationId, saved)
      return { ...turn, reply: undefined, replyKey: saved.key }
    }
  )
  const post = { ...message, turns }
  const bytes = Buffer.byteLength(JSON.stringify(post)) + 1
  const projected = { post, previews, bytes }
  pagePosts.set(message, projected)
  return projected
}

/** Admit whole posts newest first. Posts before this cursor retain their previews on older pages. */
export function presentBotGroupPage(
  group: BotGroup,
  messages: readonly BotGroupMessage[],
  knownReplyKeys: readonly string[] | undefined
): BotGroupMessage[] {
  const known = new Set(knownReplyKeys)
  const page: BotGroupMessage[] = []
  let remaining =
    REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES -
    PAGE_ENVELOPE_BYTES -
    Buffer.byteLength(JSON.stringify(group))
  for (const message of messages.toReversed()) {
    const { post, previews, bytes } = projectPost(message)
    const previewBytes = [...previews.values()].reduce((total, reply) => total + reply.bytes, 0)
    if (page.length && bytes + previewBytes > remaining) {
      break
    }
    let available = remaining - bytes
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
    remaining -= bytes + previewBytes
  }
  return page.toReversed()
}
