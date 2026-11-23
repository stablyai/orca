// Where a new bot request sits in its chain, kept on its record for tracing: a turn a request woke
// continues that request's chain.
import { createHash } from 'node:crypto'
import type { BotActingTurn } from '../../../../../bots/bot-request-asker'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'

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

/** One send: from this turn, to this bot, of this kind, with this text. */
export function botRequestSendKey(
  turnKey: string,
  toBotId: string,
  purpose: string,
  text: { subject: string; body?: string | null }
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([text.subject, text.body ?? '']))
    .digest('hex')
  return JSON.stringify([turnKey, toBotId, purpose, digest])
}
