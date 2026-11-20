import type { BotGroupMessage, BotGroupTurn } from '../../shared/bots/bot-group'
import { requireStructuredHost } from './bot-chat-session'
import type { BotGroupRuntime } from './bot-group-runtime'

/** What a mail turn whose operation can never run settles to, in place of "Starting…". */
export const BOT_GROUP_MAIL_NEVER_STARTED = 'This mail never started a turn.'

/** The chat proves the operation never ran and never will. */
const NEVER_RAN = new Set(['absent', 'refused', 'withdrawn'])
/** The chat holds a send the room renders from itself; nothing to settle, ever. */
const ANSWERED = new Set(['accepted', 'rejected', 'unknown'])

/**
 * Settles, as a page is read, mail turns whose operation neither the mail lane nor the chat holds:
 * an attempt refused or withdrawn before it ran, whose mail went on under another id or not at
 * all. Lines saved before mail lines followed their retries are repaired the same way. A card
 * still queued, or an attempt still in the lane, is left alone.
 */
export function settleDeadGroupMailTurns(
  groups: BotGroupRuntime,
  messages: readonly BotGroupMessage[]
): void {
  for (const message of messages) {
    for (const turn of message.turns) {
      const { operationId } = turn
      if (
        !turn.mailbox ||
        turn.error !== undefined ||
        turn.revoked ||
        turn.reply !== undefined ||
        turn.frozenItems ||
        groups.mailTurnChecks.has(operationId)
      ) {
        continue
      }
      groups.mailTurnChecks.set(operationId, 'checking')
      void settle(groups, message.id, turn)
        .then((answered) =>
          answered
            ? groups.mailTurnChecks.set(operationId, 'answered')
            : groups.mailTurnChecks.delete(operationId)
        )
        .catch((error: unknown) => {
          groups.mailTurnChecks.delete(operationId)
          console.warn('[bot-groups] could not check a mail turn', error)
        })
    }
  }
}

/** True when the chat answers for the turn from now on, so no read checks it again. */
async function settle(
  groups: BotGroupRuntime,
  messageId: string,
  turn: BotGroupTurn
): Promise<boolean> {
  // The lane reserves its attempt before the turn is recorded and drops it only once the send
  // answered: while it holds the id, admission may still be under way.
  if (
    groups.runtime
      .getOrchestrationDb()
      .holdsStructuredMailSendOperation(turn.sessionId, turn.operationId)
  ) {
    return false
  }
  const host = await requireStructuredHost(groups.runtime)
  const answer = await host.sendAnswer(turn.sessionId, turn.operationId)
  if (ANSWERED.has(answer.kind)) {
    return true
  }
  if (!NEVER_RAN.has(answer.kind)) {
    return false
  }
  // Read again: the line may have followed the mail's next attempt meanwhile.
  const current = groups.store.message(messageId)
  if (
    !current?.turns.some(
      (item) => item.operationId === turn.operationId && item.error === undefined
    )
  ) {
    return false
  }
  groups.store.update({
    ...current,
    turns: current.turns.map((item) =>
      item.operationId === turn.operationId
        ? { ...item, error: BOT_GROUP_MAIL_NEVER_STARTED }
        : item
    )
  })
  groups.changed()
  return false
}
