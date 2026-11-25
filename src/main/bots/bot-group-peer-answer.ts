import { liveGroupOperation } from './bot-group-peer-requests'
import type { BotGroupRuntime } from './bot-group-runtime'
import type { MessageRow } from '../runtime/orchestration/db/orchestration-records'
import { exposeUtcTimestamp } from '../runtime/orchestration/db/utc-timestamp'

/** The room turn a member's answer to a peer's request shows on: the live turn sending it, read
 *  before the reply is written so the reply can tell the asker the room shows it. */
export async function groupAnswerTurn(
  groups: BotGroupRuntime,
  sessionId: string,
  text: string
): Promise<string | null> {
  const operationId = text.trim() ? await liveGroupOperation(groups, sessionId) : null
  return operationId && groups.store.operationMessage(operationId) ? operationId : null
}

/** Shows the answer on that turn, after any answer it already sent; run once the reply is written,
 *  so a refused reply never shows. */
export function saveGroupPeerAnswer(
  groups: BotGroupRuntime,
  operationId: string,
  reply: Pick<MessageRow, 'body' | 'created_at'>
): void {
  const message = groups.store.operationMessage(operationId)
  if (!message) {
    return
  }
  const sentAt = Date.parse(exposeUtcTimestamp(reply.created_at) ?? '')
  groups.store.update({
    ...message,
    turns: message.turns.map((turn) =>
      turn.operationId === operationId
        ? {
            ...turn,
            answer: turn.answer ? `${turn.answer}\n\n${reply.body}` : reply.body,
            answerAt: Number.isFinite(sentAt) ? sentAt : turn.answerAt
          }
        : turn
    )
  })
  groups.changed(message.groupId)
}
