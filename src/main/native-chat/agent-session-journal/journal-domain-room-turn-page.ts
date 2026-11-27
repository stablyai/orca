import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  HISTORY_PAGE_CONTENT_BUDGET_BYTES,
  oversizedHistoryItem
} from '../agent-session-wire/publication/history/agent-session-history-page-bounds'
import { AGENT_SESSION_ITEM_WIRE_VERSION } from '../agent-session-wire/publication/history/agent-session-item-presentation-contract'
import { readJournalDomainClientItems } from './journal-domain-item-presentation'
import { readJournalDomainHistoryEnvelope } from './journal-domain-history-window'
import { SEND_QUEUED_CARD_SQL } from './database/journal-submission-window-indexes'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalRoomTurnPageRequest = {
  operationId: string
  turnItemId?: string
  workerDispatchIds?: readonly string[]
  before?: RoomTurnPosition
  onlyWorkers?: boolean
}

type RoomTurnPosition = [sequence: number, sequenceIndex: number, ordinal: number]

export type JournalRoomTurnPage = {
  items: AgentJournalRenderItem[]
  before?: RoomTurnPosition
  workersRead: number
}

const DETAIL_LIMIT = 128
const VISIBLE = 'session_id=? AND epoch=? AND hidden=0'
const NEWEST = 'ORDER BY sequence DESC, sequence_index DESC, ordinal DESC'
const BY_ID = `FROM journal_items WHERE ${VISIBLE} AND item_id=?`
const BYTES = `CASE WHEN wire_version=${AGENT_SESSION_ITEM_WIRE_VERSION}
  THEN COALESCE(wire_bytes,octet_length(payload_json))
  ELSE octet_length(payload_json)+COALESCE(octet_length(output_blob),0) END`

export function readJournalDomainRoomTurnPage(
  scope: JournalSqlScope,
  request: JournalRoomTurnPageRequest
): JournalRoomTurnPage {
  const turnId = request.turnItemId ?? legacyTurnItemId(scope, request.operationId)
  if (!turnId) {
    return { items: [], workersRead: request.workerDispatchIds?.length ?? 0 }
  }
  const { db, prefix } = scope
  const position = db.prepare(`SELECT sequence ${BY_ID} AND kind='turn'`).get(...prefix, turnId)
  if (!position) {
    return { items: [], workersRead: request.workerDispatchIds?.length ?? 0 }
  }
  const start = Number(position.sequence)
  const root = db
    .prepare(`SELECT sequence FROM journal_items INDEXED BY journal_items_teardown_turn
    WHERE ${VISIBLE} AND root=1 AND turn_id IS NOT NULL AND queue_command_turn=0 AND sequence>?
    ORDER BY sequence LIMIT 1`)
    .get(...prefix, start)
  const end = Number(root?.sequence ?? Number.MAX_SAFE_INTEGER)
  const answer = db
    .prepare(`SELECT item_id FROM (SELECT item_id,turn_item_id
    FROM journal_items INDEXED BY journal_items_status_prose WHERE ${VISIBLE} AND root=1
      AND message_role='assistant' AND command_entry=0 AND assistant_prose=1
      AND sequence>=? AND sequence<? ${NEWEST} LIMIT ?) WHERE turn_item_id=? LIMIT 1`)
    .get(...prefix, start, Number(root?.sequence ?? Number.MAX_SAFE_INTEGER), DETAIL_LIMIT, turnId)
  const ids: string[] = []
  let budget = HISTORY_PAGE_CONTENT_BUDGET_BYTES - 2 * DETAIL_LIMIT
  for (const id of request.onlyWorkers
    ? []
    : [turnId, ...(answer ? [String(answer.item_id)] : [])]) {
    const header = db.prepare(`SELECT ${BYTES} AS bytes ${BY_ID}`).get(...prefix, id)
    const bytes = Number(header?.bytes ?? 0)
    if (header && bytes <= budget) {
      ids.push(id)
      budget -= bytes
    }
  }

  // Seek on the existing position index. The scoped turn is filtered from a bounded set of
  // headers, so even a window with interleaved child rows cannot scan an unbounded prefix.
  const headers = request.onlyWorkers
    ? []
    : db
        .prepare(`SELECT item_id, sequence, sequence_index, ordinal, turn_item_id, ${BYTES} AS bytes
    FROM journal_items INDEXED BY journal_items_visible_position WHERE ${VISIBLE}
    AND sequence>=? AND sequence<? AND (sequence, sequence_index, ordinal)<(?,?,?) ${NEWEST} LIMIT ?`)
        .all(...prefix, start, end, ...(request.before ?? [end, 0, 0]), DETAIL_LIMIT + 1)
  const oversized: AgentJournalRenderItem[] = []
  let consumed = 0
  let kept = 0
  const seen = new Set(ids)
  for (const header of headers.slice(0, DETAIL_LIMIT)) {
    scope.examined(header)
    const id = String(header.item_id)
    if (header.turn_item_id !== turnId || seen.has(id)) {
      consumed++
      continue
    }
    const bytes = Number(header.bytes)
    if (bytes > budget) {
      if (kept === 0) {
        oversized.push(oversizedHistoryItem(readJournalDomainHistoryEnvelope(db, prefix, id)))
        consumed++
      }
      break
    }
    ids.push(id)
    budget -= bytes
    consumed++
    kept++
  }
  const edge = consumed < headers.length ? headers[consumed - 1] : undefined
  // Linked worker cards are outside the provider's turn scope. Their IDs were bounded at the
  // room store before coming to this owner.
  const workersBudget = HISTORY_PAGE_CONTENT_BUDGET_BYTES - 2 * DETAIL_LIMIT
  let workersRead = 0
  for (const dispatch of request.workerDispatchIds ?? []) {
    const id = agentJournalSubmissionKey(`agent-start:${dispatch}`)
    const header = db.prepare(`SELECT ${BYTES} AS bytes ${BY_ID}`).get(...prefix, id)
    const bytes = Number(header?.bytes ?? 0)
    if (header && bytes <= budget) {
      ids.push(id)
      budget -= bytes
    } else if (header && bytes > workersBudget) {
      oversized.push(oversizedHistoryItem(readJournalDomainHistoryEnvelope(db, prefix, id)))
    } else if (header) {
      break
    }
    workersRead++
  }
  const items = [...readJournalDomainClientItems(db, scope, ids), ...oversized]
  return {
    workersRead,
    items: items.sort(
      (a, b) => a.sequence - b.sequence || (a.sequenceIndex ?? 0) - (b.sequenceIndex ?? 0)
    ),
    ...(edge
      ? { before: [Number(edge.sequence), Number(edge.sequence_index), Number(edge.ordinal)] }
      : {})
  }
}

function legacyTurnItemId(
  { db, prefix }: JournalSqlScope,
  operationId: string
): string | undefined {
  const columns = `item_id,provider_item_id,json_extract(payload_json,'$.answeredInTurn.turnItemId') AS answered`
  const byId = db.prepare(`SELECT ${columns} FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND current=1 AND message_id=?`)
  const direct = byId.get(...prefix, operationId)
  const card = direct
    ? undefined
    : db
        .prepare(`SELECT json_extract(payload_json,'$.consumedAs') AS send
    FROM journal_queue_cards WHERE session_id=? AND epoch=? AND message_id=?`)
        .get(...prefix, operationId)
  const consumed = typeof card?.send === 'string' ? byId.get(...prefix, card.send) : undefined
  const send =
    direct ??
    consumed ??
    db
      .prepare(`SELECT ${columns} FROM journal_submission_attempts
    INDEXED BY journal_submission_queued_card WHERE session_id=? AND epoch=? AND current=1
    AND ${SEND_QUEUED_CARD_SQL}=? LIMIT 1`)
      .get(...prefix, operationId)
  const keys = [send?.item_id ?? agentJournalSubmissionKey(operationId), send?.provider_item_id]
  let promptSequence: number | undefined
  for (const id of keys) {
    if (typeof id !== 'string') {
      continue
    }
    const prompt = db
      .prepare(`SELECT turn_item_id,sequence ${BY_ID} AND message_role='user'`)
      .get(...prefix, id)
    if (typeof prompt?.turn_item_id === 'string') {
      return prompt.turn_item_id
    }
    const opener = db
      .prepare(`SELECT item_id FROM journal_items INDEXED BY journal_items_opener
      WHERE ${VISIBLE} AND opener_item_id=? AND root=1 AND kind='turn' LIMIT 1`)
      .get(...prefix, id)
    if (typeof opener?.item_id === 'string') {
      return opener.item_id
    }
    if (prompt) {
      promptSequence ??= Number(prompt.sequence)
    }
  }
  if (typeof send?.answered === 'string') {
    return send.answered
  }
  if (promptSequence === undefined) {
    return undefined
  }
  const next = db
    .prepare(`SELECT item_id,sequence,opener_item_id FROM journal_items INDEXED BY journal_items_teardown_turn
    WHERE ${VISIBLE} AND root=1 AND turn_id IS NOT NULL AND queue_command_turn=0 AND sequence>?
    ORDER BY sequence LIMIT 1`)
    .get(...prefix, promptSequence)
  const intervening =
    next &&
    db
      .prepare(`SELECT 1 FROM journal_items INDEXED BY journal_items_status_prompt
    WHERE ${VISIBLE} AND prompt=1 AND sequence>? AND sequence<? LIMIT 1`)
      .get(...prefix, promptSequence, next.sequence)
  return !intervening && next?.opener_item_id === null ? String(next.item_id) : undefined
}
