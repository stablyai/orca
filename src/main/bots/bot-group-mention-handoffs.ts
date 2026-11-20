// A member's reply that names other members as @Name wakes them under the same person's post.
import type { BotGroupMessage, BotGroupTurn } from '../../shared/bots/bot-group'
import { botGroupReplyMentions } from '../../shared/bots/bot-group-mentions'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { BOT_GROUP_HANDOFF_LIMIT, deliverTurn } from './bot-group-delivery'
import { reserveGroupTurns } from './bot-group-turn-reservation'
import type { BotGroupRuntime } from './bot-group-runtime'

/** Wakes each member `reply` names, on a line of its own under the post `message` serves, up to
 *  that post's hand-off limit; past it the room shows one paused line, and a person's next post
 *  starts a fresh count. Explicit peer requests (mail turns) neither count nor follow mentions. */
export async function handOffGroupMentions(
  groups: BotGroupRuntime,
  message: BotGroupMessage,
  turn: BotGroupTurn,
  reply: string
): Promise<void> {
  if (turn.mailbox) {
    return
  }
  const rootRequestId = message.rootRequestId ?? message.id
  const rootSequence = message.rootSequence ?? message.sequence
  const { groupId, threadId } = message
  const woken = await runKeyedSerializedOperation(groups.queues, groupId, async () => {
    if (groups.store.message(rootRequestId)?.author.kind !== 'owner') {
      return []
    }
    const room = groups.store.room(groupId, threadId)
    // A person's Stop after the post holds every member, the speaker included.
    const active = (botId: string) =>
      room.members.some(
        (member) => member.botId === botId && (member.stoppedThroughSequence ?? 0) < rootSequence
      )
    const bots = groups.runtime.bots.list()
    const lineId = (botId: string) => `handoff:${turn.operationId}:${botId}`
    const targets = active(turn.botId)
      ? botGroupReplyMentions(reply, room, bots, turn.botId).filter(
          (botId) =>
            active(botId) &&
            bots.some((bot) => bot.id === botId && !bot.paused) &&
            // A replayed turn end wakes no one twice.
            !groups.store.message(lineId(botId))
        )
      : []
    if (targets.length === 0) {
      return []
    }
    const lines = groups.store.continuing(groupId, rootRequestId)
    const place = { groupId, ...(threadId ? { threadId } : {}), rootRequestId, rootSequence }
    const speaker = { kind: 'bot' as const, id: turn.botId, name: turn.botName }
    const used = lines.filter((line) => line.mentioned).length
    const waking = targets.slice(0, Math.max(0, BOT_GROUP_HANDOFF_LIMIT - used))
    const { turns, contexts } = await reserveGroupTurns(groups, room, threadId, bots, waking)
    const stored = turns.map((woken) =>
      groups.store.append(
        {
          ...place,
          id: lineId(woken.botId),
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
    if (waking.length < targets.length && !lines.some((line) => line.pausedAfter)) {
      groups.store.append({
        ...place,
        id: `handoffs-paused:${rootRequestId}`,
        author: speaker,
        text: `Paused after ${BOT_GROUP_HANDOFF_LIMIT} hand-offs. Reply to continue.`,
        createdAt: Date.now(),
        pausedAfter: BOT_GROUP_HANDOFF_LIMIT,
        turns: []
      })
    }
    groups.changed()
    return stored
  })
  for (const line of woken) {
    for (const wokenTurn of line.turns) {
      void deliverTurn(groups, line, wokenTurn)
    }
  }
}
