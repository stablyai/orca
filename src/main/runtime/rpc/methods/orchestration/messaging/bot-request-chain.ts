// Where a new bot request sits in its chain, kept on its record for tracing: a turn a request opened
// continues that request's chain; one a person opened keeps its own, whatever is steered in after. An item made in a turn records the same chain as its origin.
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
  /** The new request's hop: 1 from a turn that took no request, one past the deepest one it took. */
  depth: number
  /** The chain's key, the request's that opened the turn; null for a send no turn names, which starts its own. */
  rootKey: string | null
  /** The sending turn, which with a send's target and text names that send; null when no turn does. */
  turnKey: string | null
  /** How the chain started: the turn's own start, or the one its opening request recorded. */
  start: BotRequestStart
}

type ChainTurn = Pick<
  BotActingTurn,
  | 'rootItemId'
  | 'requestIds'
  | 'askedBy'
  | 'openedBy'
  | 'openedAt'
  | 'ownerRequest'
  | 'openedItemId'
>

/** A turn no request woke starts its chain: who or what sent the message that opened it. */
function turnStart(sessionId: string | null, turn: ChainTurn): BotRequestStart {
  return {
    kind: isBotGroupMemberSession(sessionId)
      ? 'group'
      : (turn.openedBy ?? (actsForOwner(turn.askedBy) ? 'owner' : 'person')),
    at: turn.openedAt ?? null,
    request: turn.ownerRequest ?? null
  }
}

/** A start Orca can't tell: a record written before Orca kept it, or a turn it couldn't read. */
export const UNKNOWN_REQUEST_START: BotRequestStart = { kind: 'bot', at: null, request: null }

/** The start a request's record carries. */
function recordedStart(record: string): BotRequestStart {
  try {
    const parsed: unknown = JSON.parse(record)
    const start =
      typeof parsed === 'object' && parsed !== null && 'start' in parsed ? parsed.start : null
    return requestStartOf(start) ?? UNKNOWN_REQUEST_START
  } catch {
    return UNKNOWN_REQUEST_START
  }
}

/** An earlier request the chain joins in place of its own. */
export type BotRequestJoins = {
  /** `item add --from-item`: the request the named item was made for. Only the key is joined; who
   *  started the request, when and their words stay this chain's own. */
  fromItemKey?: string
}

/** Read from Orca's records of the waking requests, never from the sender's text. */
export function botRequestChain(
  db: OrchestrationDb,
  sessionId: string | null,
  turn: ChainTurn,
  joins: BotRequestJoins = {}
): BotRequestChain {
  const { fromItemKey } = joins
  const turnKey = sessionId && turn.rootItemId ? `${sessionId}:${turn.rootItemId}` : null
  const parents = turn.requestIds.flatMap((id) => {
    const row = db.getBotRequest(id)
    return row ? [row] : []
  })
  const depth = parents.length === 0 ? 1 : Math.max(...parents.map((row) => row.depth)) + 1
  // Only a turn a request opened has no openedBy; a request steered in later still counts for depth.
  const openingRequest = turn.openedBy === undefined ? parents[0] : undefined
  if (!openingRequest) {
    const ownKey = sessionId && turn.openedItemId ? `${sessionId}:${turn.openedItemId}` : turnKey
    return { depth, rootKey: fromItemKey ?? ownKey, turnKey, start: turnStart(sessionId, turn) }
  }
  return {
    depth,
    rootKey: fromItemKey ?? openingRequest.root_key,
    turnKey,
    start: recordedStart(openingRequest.record)
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
  turn: ChainTurn,
  joins: BotRequestJoins = {}
): BotItemOrigin | null {
  const { rootKey, start } = botRequestChain(db, sessionId, turn, joins)
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
