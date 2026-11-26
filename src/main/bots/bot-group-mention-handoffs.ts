import type { BotGroupMessage, BotGroupTurn } from '../../shared/bots/bot-group'
import { runKeyedSerializedOperation } from '../../shared/concurrency/keyed-serialized-operations'
import { deliverGroupLines, routeSpeech } from './bot-group-speech-routing'
import type { GroupMemberReply } from './bot-group-mention-context'
import type { BotGroupRuntime } from './bot-group-runtime'

/** The final reply of a local turn. Other members named in it serve the same root. */
export async function handOffGroupMentions(
  groups: BotGroupRuntime,
  message: BotGroupMessage,
  turn: BotGroupTurn,
  reply: GroupMemberReply
): Promise<void> {
  if (message.continuation) {
    return
  }
  const lines = await runKeyedSerializedOperation(groups.queues, message.groupId, async () => {
    const current = groups.store.message(message.id)
    const speaking = current?.turns.find((candidate) => candidate.operationId === turn.operationId)
    if (!current || !speaking || speaking.handedOff) {
      return []
    }
    const mailed = new Set(speaking.mailed)
    if (speaking.answer !== undefined && current.requester) {
      mailed.add(current.requester.id)
    }
    return routeSpeech(groups, current, {
      triggerId: turn.operationId,
      speaker: { kind: 'local', botId: turn.botId, sessionId: turn.sessionId, name: turn.botName },
      reply,
      mailed,
      commit: (targets) => markHandedOff(groups, message.id, turn.operationId, targets)
    })
  })
  deliverGroupLines(groups, lines)
}

/** Records that a member's turn sent a peer request to `botId`; a send from no room turn has none. */
export function noteGroupTurnMailed(
  groups: BotGroupRuntime,
  operationId: string | undefined,
  botId: string
): void {
  const message = operationId ? groups.store.operationMessage(operationId) : null
  if (!message) {
    return
  }
  groups.store.update({
    ...message,
    turns: message.turns.map((turn) =>
      turn.operationId === operationId && !turn.mailed?.includes(botId)
        ? { ...turn, mailed: [...(turn.mailed ?? []), botId] }
        : turn
    )
  })
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
