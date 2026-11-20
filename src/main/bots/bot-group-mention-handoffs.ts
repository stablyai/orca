// A member's reply that names other members as @Name wakes them under the same person's post.
import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import {
  BOT_GROUP_CONTEXT_MAX,
  fitBotGroupContext,
  type BotGroupMessage,
  type BotGroupTurn
} from '../../shared/bots/bot-group'
import { botGroupReplyMentions } from '../../shared/bots/bot-group-mentions'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { BOT_GROUP_HANDOFF_LIMIT, deliverTurn } from './bot-group-delivery'
import { reserveGroupTurns } from './bot-group-turn-reservation'
import type { BotGroupRuntime } from './bot-group-runtime'

// GFM, as replies render: table cells end inline code at a pipe.
const markdown = unified().use(remarkParse).use(remarkGfm)

/** `reply` with its Markdown code (fenced, indented, inline) and block quotes blanked in place,
 *  lines and offsets kept; text with no `@` has nothing to blank. */
export function blankMarkdownCode(reply: string): string {
  if (!reply.includes('@')) {
    return reply
  }
  const ranges: [number, number][] = []
  const pending: Nodes[] = [markdown.parse(reply)]
  for (let node = pending.pop(); node; node = pending.pop()) {
    const { start, end } = node.position ?? {}
    const masked = node.type === 'code' || node.type === 'inlineCode' || node.type === 'blockquote'
    if (masked && start?.offset !== undefined && end?.offset !== undefined) {
      ranges.push([start.offset, end.offset])
    } else if ('children' in node) {
      for (const child of node.children) {
        pending.push(child)
      }
    }
  }
  // Masked nodes never nest (their children are not walked), so one pass in source order builds it.
  const parts: string[] = []
  let cursor = 0
  for (const [start, end] of ranges.toSorted((left, right) => left[0] - right[0])) {
    // One space per UTF-16 unit, so masked offsets index the original reply.
    const blank = reply
      .slice(start, end)
      .split('\n')
      .map((line) => ' '.repeat(line.length))
      .join('\n')
    parts.push(reply.slice(cursor, start), blank)
    cursor = end
  }
  parts.push(reply.slice(cursor))
  return parts.join('')
}

/** A finished member turn's reply: whole, as mentions read it, and as saved for room history. */
export type GroupMemberReply = { full: string; saved: string }

/** Wakes each member `reply` names, on a line of its own under the post `message` serves, up to
 *  that post's hand-off limit; past it the room shows one paused line, and a person's next post
 *  starts a fresh count. Explicit peer requests (mail turns) neither count nor follow mentions. */
export async function handOffGroupMentions(
  groups: BotGroupRuntime,
  message: BotGroupMessage,
  turn: BotGroupTurn,
  reply: GroupMemberReply
): Promise<void> {
  if (turn.mailbox) {
    return
  }
  const rootRequestId = message.rootRequestId ?? message.id
  const rootSequence = message.rootSequence ?? message.sequence
  const { groupId, threadId } = message
  const woken = await runKeyedSerializedOperation(groups.queues, groupId, async () => {
    // A turn's hand-offs are reserved once; a replayed end finds them marked and wakes no one.
    const speaking = groups.store
      .message(message.id)
      ?.turns.find((candidate) => candidate.operationId === turn.operationId)
    const root = groups.store.message(rootRequestId)
    if (!speaking || speaking.handedOff || root?.author.kind !== 'owner') {
      return []
    }
    const room = groups.store.room(groupId, threadId)
    // A person's Stop after the post holds every member; the speaker must be the same member session.
    const active = (botId: string, sessionId?: string) =>
      room.members.some(
        (member) =>
          member.botId === botId &&
          (sessionId === undefined || member.sessionId === sessionId) &&
          (member.stoppedThroughSequence ?? 0) < rootSequence
      )
    const bots = groups.runtime.bots.list()
    const named = active(turn.botId, turn.sessionId)
      ? botGroupReplyMentions(blankMarkdownCode(reply.full), room, bots, turn.botId).filter(
          ({ id }) => active(id) && bots.some((bot) => bot.id === id && !bot.paused)
        )
      : []
    const targets = named.map(({ id }) => id)
    if (targets.length === 0) {
      // Saved empty too: a replay after a named member resumes or joins still wakes no one.
      markHandedOff(groups, message.id, turn.operationId, [])
      return []
    }
    const used = root.handoffs ?? 0
    const waking = targets.slice(0, Math.max(0, BOT_GROUP_HANDOFF_LIMIT - used))
    const { turns, contexts } = await reserveGroupTurns(groups, room, threadId, bots, waking)
    // Each woken member sees the part of the reply that named it, however long the reply or late
    // its history was taken.
    for (const woken of turns) {
      const start = named.find(({ id }) => id === woken.botId)?.start ?? 0
      const context = contexts.get(woken.operationId)
      if (context !== undefined) {
        contexts.set(woken.operationId, withNamingReply(context, turn, reply, start))
      }
    }
    const place = { groupId, ...(threadId ? { threadId } : {}), rootRequestId, rootSequence }
    const speaker = { kind: 'bot' as const, id: turn.botId, name: turn.botName }
    const pausedId = `handoffs-paused:${rootRequestId}`
    const stored: BotGroupMessage[] = []
    // The marker, the count, each woken line with its owed delivery and the paused line commit
    // together; each record is read as it stands now, after the reservation's reads.
    groups.store.transaction(() => {
      markHandedOff(groups, message.id, turn.operationId, targets)
      const post = groups.store.message(rootRequestId)
      if (post) {
        groups.store.update({ ...post, handoffs: used + turns.length })
      }
      for (const woken of turns) {
        stored.push(
          groups.store.append(
            {
              ...place,
              id: `handoff:${turn.operationId}:${woken.botId}`,
              author: speaker,
              // Room history for the other members; the room line renders from `requester`.
              text: `${turn.botName} asked ${woken.botName}`,
              createdAt: Date.now(),
              requester: { id: turn.botId, name: turn.botName },
              mentioned: true,
              turns: [woken]
            },
            contexts
          )
        )
      }
      if (waking.length < targets.length && !groups.store.message(pausedId)) {
        groups.store.append({
          ...place,
          id: pausedId,
          author: speaker,
          text: `Paused after ${BOT_GROUP_HANDOFF_LIMIT} hand-offs. Reply to continue.`,
          createdAt: Date.now(),
          pausedAfter: BOT_GROUP_HANDOFF_LIMIT,
          turns: []
        })
      }
    })
    groups.changed()
    return stored
  })
  for (const line of woken) {
    for (const wokenTurn of line.turns) {
      void deliverTurn(groups, line, wokenTurn)
    }
  }
}

function markHandedOff(
  groups: BotGroupRuntime,
  messageId: string,
  operationId: string,
  handedOff: string[]
): void {
  const source = groups.store.message(messageId)
  if (source) {
    groups.store.update({
      ...source,
      turns: source.turns.map((turn) =>
        turn.operationId === operationId ? { ...turn, handedOff } : turn
      )
    })
  }
}

/** Around a mention past the saved tail of a long reply: what a woken member is asked to do. */
const EXCERPT_BEFORE = 1_000
const EXCERPT_AFTER = 3_000

/** `context` (the quoted history lines) holding the speaker's reply where it names this member: the
 *  saved reply when the mention is in it, else an excerpt around the mention, cut further around
 *  the mention until it alone fits the room-history budget. That line is kept and older lines go
 *  first to fit the rest. */
function withNamingReply(
  context: string,
  speaker: BotGroupTurn,
  reply: GroupMemberReply,
  mentionAt: number
): string {
  const lines: unknown[] = JSON.parse(context)
  const author = { kind: 'bot', id: speaker.botId, name: speaker.botName }
  const savedFrom = reply.full.length - reply.saved.length
  const inSaved = mentionAt >= savedFrom
  const source = inSaved ? reply.saved : reply.full
  const at = inSaved ? mentionAt - savedFrom : mentionAt
  let before = inSaved ? at : EXCERPT_BEFORE
  let after = inSaved ? source.length - at : EXCERPT_AFTER
  let text = excerpt(source, at, before, after)
  while (JSON.stringify([{ author, text }]).length > BOT_GROUP_CONTEXT_MAX) {
    before = Math.floor(before / 2)
    after = Math.floor(after / 2)
    text = excerpt(source, at, before, after)
  }
  const index = lines.findIndex(
    (line) =>
      typeof line === 'object' &&
      line !== null &&
      'text' in line &&
      line.text === text &&
      'author' in line &&
      JSON.stringify(line.author) === JSON.stringify(author)
  )
  return index === -1
    ? fitBotGroupContext([...lines, { author, text }], 1)
    : fitBotGroupContext(lines, lines.length - index)
}

/** `source` from `before` units ahead of `at` to `after` units past it, marked where cut. */
function excerpt(source: string, at: number, before: number, after: number): string {
  const from = Math.max(0, at - before)
  const to = Math.min(source.length, at + after)
  return `${from > 0 ? '…' : ''}${source.slice(from, to)}${to < source.length ? '…' : ''}`
}
