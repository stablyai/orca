import { liveGroupOperation } from './bot-group-peer-requests'
import type { BotGroupRuntime } from './bot-group-runtime'

/** A member's answer to a peer's request goes to the asker as mail; the room shows it on the turn
 *  that sent it, after any answer that turn already sent. */
export async function noteGroupPeerAnswer(
  groups: BotGroupRuntime,
  sessionId: string,
  text: string
): Promise<void> {
  const operationId = text.trim() ? await liveGroupOperation(groups, sessionId) : null
  const message = operationId ? groups.store.operationMessage(operationId) : null
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
  groups.changed()
}
