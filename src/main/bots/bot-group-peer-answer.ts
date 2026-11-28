import { liveGroupOperation } from './bot-group-peer-requests'
import type { BotGroupRuntime } from './bot-group-runtime'

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
  text: string
): void {
  const message = groups.store.operationMessage(operationId)
  if (!message) {
    return
  }
  groups.store.update({
    ...message,
    turns: message.turns.map((turn) =>
      turn.operationId === operationId
        ? { ...turn, answer: turn.answer ? `${turn.answer}\n\n${text}` : text }
        : turn
    )
  })
  groups.changed(message.groupId)
}
