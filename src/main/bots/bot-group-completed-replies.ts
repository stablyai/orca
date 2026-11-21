// Settles finished member turn replies onto their group messages so later posts quote them without
// reopening member chats on every send.
import {
  botGroupCompletedText,
  botGroupTurnReplyText,
  type BotGroupMessage,
  type BotGroupTurn
} from '../../shared/bots/bot-group'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import { botChatReads } from './bot-chat-reads'
import type { BotGroupRuntime } from './bot-group-runtime'

/** Each finished turn's reply text, keyed by operation: saved when the turn ended, or a retired
 *  member's from its frozen rows. Only turns saved before replies were read their member's chat. */
export async function completedGroupReplies(
  groups: BotGroupRuntime,
  messages: readonly BotGroupMessage[]
): Promise<Map<string, string>> {
  const turns = messages.flatMap((message) => message.turns)
  const unsaved = Map.groupBy(
    turns.filter((turn) => turn.reply === undefined && !turn.frozenItems && !turn.error),
    (turn) => turn.sessionId
  )
  const reads = botChatReads(groups.runtime)
  const read = new Map<string, AgentJournalRenderItem[]>()
  for (const [sessionId, sessionTurns] of unsaved) {
    for (const [operationId, items] of await reads.turnItems(sessionId, sessionTurns)) {
      read.set(operationId, items)
    }
  }
  const replies = new Map<string, string>()
  const completed = new Map<string, string>()
  for (const turn of turns) {
    const reply =
      turn.reply === undefined
        ? botGroupCompletedText(turn.frozenItems ?? read.get(turn.operationId) ?? [])
        : turn.reply
    if (reply) {
      replies.set(turn.operationId, reply)
    }
    // An answer to a member's request went by mail; the room history carries it too. Read as it
    // stands now: one may have been saved during the reads above.
    const answer = groups.store
      .operationMessage(turn.operationId)
      ?.turns.find((candidate) => candidate.operationId === turn.operationId)?.answer
    const text = botGroupTurnReplyText(reply, answer ?? turn.answer)
    if (text) {
      completed.set(turn.operationId, text)
    }
  }
  // What a read settles is saved too, so the next post reads that chat no more: the reply, or null
  // for a turn that ended without one (stopped, failed). Saved on the message as it stands now: the
  // reads above may have let a turn's error or reply land on it.
  const settled = new Map<string, string | null>()
  for (const [operationId, items] of read) {
    const ended = items.some((item) => item.body.kind === 'turn' && item.body.state !== 'running')
    if (replies.has(operationId) || ended) {
      settled.set(operationId, replies.get(operationId) ?? null)
    }
  }
  const found = (turn: BotGroupTurn) => turn.reply === undefined && settled.has(turn.operationId)
  for (const { id } of messages) {
    const current = groups.store.message(id)
    if (current?.turns.some(found)) {
      groups.store.update({
        ...current,
        turns: current.turns.map((turn) =>
          found(turn) ? { ...turn, reply: settled.get(turn.operationId) } : turn
        )
      })
    }
  }
  return completed
}
