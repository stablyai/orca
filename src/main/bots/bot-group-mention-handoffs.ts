// A member's reply that names other members as @Name wakes them under the same person's post.
import type { Nodes } from 'mdast'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import type { BotGroupMessage, BotGroupTurn } from '../../shared/bots/bot-group'
import { botGroupReplyMentions } from '../../shared/bots/bot-group-mentions'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { BOT_GROUP_HANDOFF_LIMIT, deliverTurn } from './bot-group-delivery'
import { reserveGroupTurns } from './bot-group-turn-reservation'
import type { BotGroupRuntime } from './bot-group-runtime'

const markdown = unified().use(remarkParse).use(remarkGfm)

/** `reply` with its Markdown code (fenced, indented, inline) blanked in place, lines and offsets kept. */
export function blankMarkdownCode(reply: string): string {
  const ranges: [number, number][] = []
  const pending: Nodes[] = [markdown.parse(reply)]
  for (let node = pending.pop(); node; node = pending.pop()) {
    const { start, end } = node.position ?? {}
    if ((node.type === 'code' || node.type === 'inlineCode') && start && end) {
      ranges.push([start.offset ?? 0, end.offset ?? 0])
    } else if ('children' in node) {
      pending.push(...node.children)
    }
  }
  let prose = reply
  for (const [start, end] of ranges) {
    const code = prose.slice(start, end).replace(/[^\n]/gu, ' ')
    prose = prose.slice(0, start) + code + prose.slice(end)
  }
  return prose
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
    const targets = active(turn.botId, turn.sessionId)
      ? botGroupReplyMentions(blankMarkdownCode(reply.full), room, bots, turn.botId).filter(
          (botId) => active(botId) && bots.some((bot) => bot.id === botId && !bot.paused)
        )
      : []
    if (targets.length === 0) {
      return []
    }
    const used = root.handoffs ?? 0
    const waking = targets.slice(0, Math.max(0, BOT_GROUP_HANDOFF_LIMIT - used))
    const { turns, contexts } = await reserveGroupTurns(groups, room, threadId, bots, waking)
    // A member whose context was reserved after a later post still sees the reply that named it.
    for (const [operationId, context] of contexts) {
      contexts.set(operationId, withSpeakerReply(context, turn, reply.saved))
    }
    const place = { groupId, ...(threadId ? { threadId } : {}), rootRequestId, rootSequence }
    const speaker = { kind: 'bot' as const, id: turn.botId, name: turn.botName }
    const pausedId = `handoffs-paused:${rootRequestId}`
    const stored: BotGroupMessage[] = []
    // The marker, the count, each woken line with its owed delivery and the paused line commit
    // together; each record is read as it stands now, after the reservation's reads.
    groups.store.transaction(() => {
      const source = groups.store.message(message.id)
      if (source) {
        groups.store.update({
          ...source,
          turns: source.turns.map((candidate) =>
            candidate.operationId === turn.operationId
              ? { ...candidate, handedOff: targets }
              : candidate
          )
        })
      }
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

/** `context` (the quoted history lines) with the speaker's reply as its last line, unless it has it. */
function withSpeakerReply(context: string, speaker: BotGroupTurn, reply: string): string {
  const lines: unknown[] = JSON.parse(context)
  const author = { kind: 'bot', id: speaker.botId, name: speaker.botName }
  const has = lines.some(
    (line) =>
      typeof line === 'object' &&
      line !== null &&
      'text' in line &&
      line.text === reply &&
      'author' in line &&
      JSON.stringify(line.author) === JSON.stringify(author)
  )
  return has ? context : JSON.stringify([...lines, { author, text: reply }])
}
