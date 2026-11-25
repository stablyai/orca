// Settles finished member turn replies onto their group messages so later posts quote them without
// reopening member chats on every send.
import {
  botGroupCompletedText,
  botGroupCompletedReply,
  botGroupTurnReplyText,
  type BotGroupMessage,
  type BotGroupTurn
} from '../../shared/bots/bot-group'
import type { AgentJournalRenderItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import type { BoundedMap } from '../../shared/collections/bounded-map'
import { botChatReads, type BotChatReads } from './bot-chat-reads'
import type { BotGroupRuntime } from './bot-group-runtime'
import type { RecoveredGroupReplies, RecoveredGroupReply } from './bot-group-listing'

/** Recover metadata from the same operation windows room history reads, including pre-preview turns. */
export async function recoverBotGroupReplies(
  messages: readonly BotGroupMessage[],
  reads: Pick<BotChatReads, 'turnItems'>,
  cache: BoundedMap<string, RecoveredGroupReply>
): Promise<RecoveredGroupReplies> {
  const recovered = new Map<string, RecoveredGroupReply>()
  const missing = Map.groupBy(
    messages.flatMap(({ turns }) =>
      turns.filter((turn) => {
        if (
          turn.frozenItems ||
          turn.error ||
          turn.revoked ||
          turn.replyAt !== undefined ||
          turn.reply === null
        ) {
          return false
        }
        const cached = cache.get(turn.operationId)
        if (cached) {
          recovered.set(turn.operationId, cached)
          return false
        }
        return true
      })
    ),
    ({ sessionId }) => sessionId
  )
  let complete = true
  for (const [sessionId, turns] of missing) {
    for (let index = 0; index < turns.length; index += 64) {
      const window = await reads
        .turnItems(sessionId, turns.slice(index, index + 64), { throughAnchoredTurns: true })
        .catch((error: unknown) => {
          complete = false
          console.warn('[bot-groups] could not recover a member reply window', error)
          return undefined
        })
      for (const [operationId, items] of window ?? []) {
        const reply = botGroupCompletedReply(items)
        if (reply) {
          const { text, completedAt, messageId } = reply
          const result = { text, completedAt, messageId }
          recovered.set(operationId, result)
          if (completedAt !== undefined) {
            cache.set(operationId, result)
          }
        }
      }
    }
  }
  return {
    complete,
    messages: messages.map((message) => ({
      ...message,
      turns: message.turns.map((turn) => {
        const reply = recovered.get(turn.operationId)
        return reply
          ? {
              ...turn,
              reply: turn.reply ?? reply.text,
              replyAt: reply.completedAt,
              replyMessageId: turn.replyMessageId ?? reply.messageId
            }
          : turn
      })
    }))
  }
}

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
  // Each message as it stands now: the reads above may have let an answer, error or reply land on it.
  const current = messages.map(({ id }) => groups.store.message(id))
  const answers = new Map(
    current
      .flatMap((message) => message?.turns ?? [])
      .map((turn) => [turn.operationId, turn.answer])
  )
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
    // An answer to a member's request went by mail; the room history carries it too.
    const text = botGroupTurnReplyText(reply, answers.get(turn.operationId) ?? turn.answer)
    if (text) {
      completed.set(turn.operationId, text)
    }
  }
  // What a read settles is saved too, so the next post reads that chat no more: the reply, or null
  // for a turn that ended without one (stopped, failed). Saved on the message as it stands now.
  const settled = new Map<string, string | null>()
  for (const [operationId, items] of read) {
    const ended = items.some((item) => item.body.kind === 'turn' && item.body.state !== 'running')
    if (replies.has(operationId) || ended) {
      settled.set(operationId, replies.get(operationId) ?? null)
    }
  }
  const found = (turn: BotGroupTurn) => turn.reply === undefined && settled.has(turn.operationId)
  for (const message of current) {
    if (message?.turns.some(found)) {
      groups.store.update({
        ...message,
        turns: message.turns.map((turn) =>
          found(turn) ? { ...turn, reply: settled.get(turn.operationId) } : turn
        )
      })
    }
  }
  return completed
}
