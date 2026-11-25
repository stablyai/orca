// Where a new bot request sits in its chain, kept on its record for tracing: a turn a request woke
// continues that request's chain. An item made in a turn records the same chain as its origin.
import { createHash } from 'node:crypto'
import type { BotActingTurn } from '../../../../../bots/bot-request-asker'
import { requestStartOf } from '../../../../../bots/bot-items-rows'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { BotItemOrigin } from '../../../../../../shared/bots/bot-items'
import { actsForOwner } from '../../../../../../shared/bots/bot-acts-for'
import { isBotGroupMemberSession } from '../../../../../../shared/bots/bot-group'

/** How a chain's request started; it goes with the chain's key (BotItemOrigin). */
export type BotRequestStart = Omit<BotItemOrigin, 'rootKey'>

export type BotRequestChain = {
  /** The new request's hop: 1 from a person's turn, one past the deepest request that woke the turn. */
  depth: number
  /** The chain's key, its first waking request's; null for a send no turn names, which starts its own. */
  rootKey: string | null
  /** The sending turn, which with a send's target and text names that send; null when no turn does. */
  turnKey: string | null
  /** How the chain started: the turn's own start, or the one its first waking request recorded. */
  start: BotRequestStart
}

type ChainTurn = Pick<
  BotActingTurn,
  'rootItemId' | 'requestIds' | 'askedBy' | 'byAutomation' | 'openedAt' | 'ownerRequest'
>

/** A turn no request woke starts its chain: who or what sent the message that opened it. */
function turnStart(sessionId: string | null, turn: ChainTurn): BotRequestStart {
  return {
    kind: isBotGroupMemberSession(sessionId)
      ? 'group'
      : turn.byAutomation
        ? 'automation'
        : actsForOwner(turn.askedBy)
          ? 'owner'
          : 'person',
    at: turn.openedAt ?? null,
    request: turn.ownerRequest ?? null
  }
}

/** The start a request's record carries; `bot` for a record written before Orca kept it. */
function recordedStart(record: string): BotRequestStart {
  try {
    const parsed: unknown = JSON.parse(record)
    const start =
      typeof parsed === 'object' && parsed !== null && 'start' in parsed ? parsed.start : null
    return requestStartOf(start) ?? { kind: 'bot', at: null, request: null }
  } catch {
    return { kind: 'bot', at: null, request: null }
  }
}

/** Read from Orca's records of the waking requests, never from the sender's text. */
export function botRequestChain(
  db: OrchestrationDb,
  sessionId: string | null,
  turn: ChainTurn
): BotRequestChain {
  const turnKey = sessionId && turn.rootItemId ? `${sessionId}:${turn.rootItemId}` : null
  const parents = turn.requestIds.flatMap((id) => {
    const row = db.getBotRequest(id)
    return row ? [row] : []
  })
  if (parents.length === 0) {
    return { depth: 1, rootKey: turnKey, turnKey, start: turnStart(sessionId, turn) }
  }
  return {
    depth: Math.max(...parents.map((row) => row.depth)) + 1,
    rootKey: parents[0].root_key,
    turnKey,
    start: recordedStart(parents[0].record)
  }
}

/** The request a bot request is for, as the items its receiving bot makes for it record it. */
export function botRequestOrigin(db: OrchestrationDb, messageId: string): BotItemOrigin | null {
  const row = db.getBotRequest(messageId)
  return row ? { rootKey: row.root_key, ...recordedStart(row.record) } : null
}

/** The request an item made in this turn records: the chain a send from the same turn records, so
 *  a request's items and the requests it led to share one key. Null when no turn names one. */
export function botTurnRequestOrigin(
  db: OrchestrationDb,
  sessionId: string,
  turn: ChainTurn
): BotItemOrigin | null {
  const { rootKey, start } = botRequestChain(db, sessionId, turn)
  return rootKey ? { rootKey, ...start } : null
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
