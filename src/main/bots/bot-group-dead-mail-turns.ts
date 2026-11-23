import { BOT_FAILURE_COPY, botFailure } from '../../shared/bots/bot-failure-copy'
import type { BotGroupMessage, BotGroupTurn } from '../../shared/bots/bot-group'
import { requireStructuredHost } from './bot-chat-session'
import type { BotGroupRuntime } from './bot-group-runtime'

/** What a mail turn whose operation can never run settles to, in place of "Starting…". */
export const BOT_GROUP_MAIL_NEVER_STARTED = BOT_FAILURE_COPY.groupMailNeverStarted

/** A turn still open (a card waiting, an attempt in the lane) is asked again no sooner than this,
 *  so reads that follow each other do not each ask the chat. */
const RECHECK_MS = 15_000
/** Past this many remembered turns the memory starts over; a turn it forgets is only asked again. */
const MAX_REMEMBERED_CHECKS = 5_000

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
  messages: readonly BotGroupMessage[],
  now = Date.now()
): void {
  const checks = groups.mailTurnChecks
  if (checks.size > MAX_REMEMBERED_CHECKS) {
    checks.clear()
  }
  for (const message of messages) {
    for (const turn of message.turns) {
      const { operationId } = turn
      const last = checks.get(operationId)
      if (
        !turn.mailbox ||
        turn.error !== undefined ||
        turn.revoked ||
        turn.reply !== undefined ||
        turn.frozenItems ||
        last?.state === 'checking' ||
        last?.state === 'answered' ||
        (last && now - last.at < RECHECK_MS)
      ) {
        continue
      }
      checks.set(operationId, { state: 'checking', at: now })
      void settle(groups, message.id, turn)
        .then((answered) =>
          checks.set(operationId, { state: answered ? 'answered' : 'open', at: Date.now() })
        )
        .catch((error: unknown) => {
          checks.set(operationId, { state: 'open', at: Date.now() })
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
  // Mail still unread is still owed: a refused attempt parks it for the chat's next edge, and the
  // line follows the next attempt. Lines saved before they were keyed by mail name no mail.
  const db = groups.runtime.getOrchestrationDb()
  if (
    db.holdsStructuredMailSendOperation(turn.sessionId, turn.operationId) ||
    lineMailIds(messageId, turn.sessionId).some((id) => db.getMessageById(id)?.read === 0)
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
        ? {
            ...item,
            error: BOT_GROUP_MAIL_NEVER_STARTED,
            failure: botFailure('groupMailNeverStarted')
          }
        : item
    )
  })
  groups.changed()
  return false
}

/** The mail a line keyed by mail carries: `mail:<session>:<ids>`, or `…#<n>` for a later line. */
function lineMailIds(messageId: string, sessionId: string): string[] {
  const prefix = `mail:${sessionId}:`
  return messageId.startsWith(prefix)
    ? messageId.slice(prefix.length).replace(/#\d+$/, '').split(',')
    : []
}
