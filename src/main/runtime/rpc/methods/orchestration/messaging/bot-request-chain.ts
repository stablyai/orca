// Where a new bot request sits in its chain, kept on its record for tracing: a turn a request woke
// continues that request's chain.
import { createHash, randomUUID } from 'node:crypto'
import type { BotActingTurn } from '../../../../../bots/bot-request-asker'
import type { BotRequestPurpose } from '../../../../../bots/bot-request-policy'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotRequestAdmission } from '../../../../orchestration/db/bot-requests/bot-request-store'
import { exposeMessage } from './mailbox-message-receipt'

export type BotRequestChain = {
  /** The new request's hop: 1 from a person's turn, one past the deepest request that woke the turn. */
  depth: number
  /** The chain's key, its first waking request's; null for a send no turn names, which starts its own. */
  rootKey: string | null
  /** The sending turn, which with a send's target and text names that send; null when no turn does. */
  turnKey: string | null
}

/** Read from Orca's records of the waking requests, never from the sender's text. */
export function botRequestChain(
  db: OrchestrationDb,
  sessionId: string | null,
  turn: Pick<BotActingTurn, 'rootItemId' | 'requestIds'>
): BotRequestChain {
  const turnKey = sessionId && turn.rootItemId ? `${sessionId}:${turn.rootItemId}` : null
  const parents = turn.requestIds.flatMap((id) => {
    const row = db.getBotRequest(id)
    return row ? [row] : []
  })
  if (parents.length === 0) {
    return { depth: 1, rootKey: turnKey, turnKey }
  }
  return {
    depth: Math.max(...parents.map((row) => row.depth)) + 1,
    rootKey: parents[0].root_key,
    turnKey
  }
}

export function botRequestAdmissionKey(
  chain: BotRequestChain,
  worker: string | undefined,
  toBotId: string,
  purpose: BotRequestPurpose,
  message: BotRequestMessage
) {
  // A worker's send is its own even when a sibling asks the same thing.
  const sendTurn = worker ? `dispatch:${worker}` : chain.turnKey
  return {
    rootKey: chain.rootKey ?? `send:${randomUUID()}`,
    ...(sendTurn ? { sendKey: botRequestSendKey(sendTurn, toBotId, purpose, message) } : {}),
    toBotId,
    purpose
  }
}

type BotRequestMessage = { subject: string; body?: string | null; model?: string; effort?: string }

/** One send from this turn, including any explicit launch choices. */
function botRequestSendKey(
  turnKey: string,
  toBotId: string,
  purpose: string,
  message: BotRequestMessage
): string {
  const selection = message.model === undefined ? [] : [message.model, message.effort ?? null]
  const digest = createHash('sha256')
    .update(JSON.stringify([message.subject, message.body ?? '', ...selection]))
    .digest('hex')
  return JSON.stringify([turnKey, toBotId, purpose, digest])
}

export function botRequestDuplicateReceipt(
  db: OrchestrationDb,
  botName: string,
  blocked: Exclude<BotRequestAdmission, { kind: 'sent' }>
): { sent: false; receipt: unknown } {
  const earlier = db.getMessageById(blocked.messageId)
  return {
    sent: false,
    receipt: {
      ...(earlier ? { message: exposeMessage(earlier) } : {}),
      duplicate: true,
      next: `${botName} already has this request, so no second message was sent.`
    }
  }
}
