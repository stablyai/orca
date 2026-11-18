import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import type { JournalSqlScope } from './journal-sql-scope'
import type { SqliteRow } from '../../sqlite/sqlite-statement'

/** Where a reader's interest starts; the window runs from a turn ahead of the earliest to the head. */
export type JournalOperationWindowAnchors = {
  /** Sends, by client message id or by the queued card id they carried. */
  operationIds?: readonly string[]
  /** Rows by item id. */
  itemIds?: readonly string[]
  /** Turn rows by the provider's turn id. */
  turnIds?: readonly string[]
  /** The turn row whose end is newest, the last of any tie. */
  latestEndedTurn?: boolean
  /** The newest this many root turns; fewer than that is the whole conversation. */
  latestTurns?: number
  /** Every row after this sequence. */
  afterSequence?: number
  /** Every row observed at or after this time, with the turns that hold them. */
  observedSince?: number
  /** A send still unanswered from before the anchors (one Orca died handing over) neither widens
   *  the window nor comes along; later ones, and ones with no rows yet, still do. */
  anchorsOnly?: boolean
  /** No turn ahead of the anchors: for readers that weigh only the anchored turns' own rows. */
  withoutTurnAhead?: boolean
  /** Tool calls come without their output text (its size and digest stay), which SQLite drops
   *  before the reader decodes a row: for readers that weigh who spoke and what ran, never what a
   *  tool printed, which is nearly all of a long chat's bytes. */
  withoutToolOutput?: boolean
  /** Only the rows that say who opened and ran each turn: messages, turn and status rows, and any
   *  row of no known turn (it ends a turn's reach); never tool calls or diffs. */
  turnShape?: boolean
}

export type JournalOperationWindow = {
  snapshot: AgentJournalSnapshot
  /** The window starts at the conversation's first row, so it holds everything. */
  complete: boolean
}

type Send = {
  messageId: string
  itemId: string
  ordinal: number
  dispatchState: string
  recovered: boolean
  providerItemId: string | null
  queuedMessageId: string | null
  submittedSequence: number | null
  /** Where its opener, the provider's row for it and the turn it was answered in sit. */
  positions: number[]
}

/**
 * The visible rows from a margin ahead of the anchors through the head, and the sends that touch
 * them: every turn the window holds has the root turn before it and that turn's prompt, and every
 * send that names, opened, steered into or shares a provider id or card with a held turn is present,
 * so per-turn readings (attribution, sole input, answers) over it equal those over the conversation.
 * Sends before the window are settled and placed ahead of every held turn, which those readings skip.
 */
export function readJournalDomainOperationWindow(
  scope: JournalSqlScope,
  anchors: JournalOperationWindowAnchors
): JournalOperationWindow {
  const sends = sendHeads(scope)
  const operations = resolveOperations(scope, sends, anchors)
  const anchored = [
    ...sends.flatMap((send) => {
      if (operations.has(send.messageId)) {
        const turns = openedTurnPositions(scope, send)
        const at = [...send.positions, ...turns]
        // Nothing of it is saved where a reading can place it: only the whole conversation answers.
        return at.length > 0 ? at : send.submittedSequence !== null ? [send.submittedSequence] : [0]
      }
      return unanswered(send) && !anchors.anchorsOnly ? send.positions : []
    }),
    ...anchorPositions(scope, anchors)
  ]
  const earliest = anchored.length > 0 ? Math.min(...anchored) : null
  let start =
    earliest === null ? null : anchors.withoutTurnAhead ? earliest : marginBefore(scope, earliest)
  let kept: Send[] = []
  // A held send's own rows, and the head it was sent at, are held too: a turn may claim a send by
  // that position. No margin here, so the window never walks back a turn per held send.
  for (;;) {
    kept = keptSends(sends, operations, start, anchors.anchorsOnly === true)
    const reach = kept.flatMap((send) => [
      ...send.positions,
      ...(send.submittedSequence !== null ? [send.submittedSequence] : [])
    ])
    const next = reach.length > 0 ? Math.min(start ?? Infinity, ...reach) : start
    if (next === null || (start !== null && next >= start)) {
      break
    }
    start = next
  }
  const items =
    start === null
      ? []
      : scope.db
          .prepare(`SELECT ${anchors.withoutToolOutput ? WITHOUT_TOOL_OUTPUT : 'payload_json'} AS payload_json
          FROM journal_items INDEXED BY journal_items_visible_position
          WHERE session_id=? AND epoch=? AND hidden=0 AND sequence>=? ${anchors.turnShape ? TURN_SHAPE : ''}
          ORDER BY sequence,sequence_index,ordinal`)
          .all(...scope.prefix, start)
          .map((row) => scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json))
  const first = scope.db
    .prepare(`SELECT MIN(sequence) AS sequence FROM journal_items INDEXED BY journal_items_visible_position
    WHERE session_id=? AND epoch=? AND hidden=0`)
    .get(...scope.prefix)?.sequence
  return {
    snapshot: {
      sessionId: scope.sessionId,
      cursor: journalDomainContextHead(scope.db, scope),
      items,
      submissions: kept.map((send) => readSend(scope, send.messageId))
    },
    complete: first === null || first === undefined || (start !== null && start <= Number(first))
  }
}

// A Diff call's patch, and so the files it edited, is its output: that one is kept.
const WITHOUT_TOOL_OUTPUT = `CASE WHEN kind='tool-call' AND json_valid(payload_json)
  AND json_extract(payload_json,'$.body.name') IS NOT 'Diff'
  THEN json_replace(payload_json,'$.body.output.head','','$.body.output.truncated',json('true'))
  ELSE payload_json END`

const TURN_SHAPE = `AND (kind IN ('message','turn','status') OR turn_scope_kind='unknown')`

/** Every current send's selectors and where its rows sit; payloads are decoded only for those kept. */
function sendHeads(scope: JournalSqlScope): Send[] {
  const at = (column: string) => `(SELECT sequence FROM journal_items item
    WHERE item.session_id=send.session_id AND item.epoch=send.epoch AND item.item_id=${column}
    AND item.hidden=0)`
  return scope.db
    .prepare(`SELECT message_id,item_id,ordinal,dispatch_state,recovered,provider_item_id,submitted_sequence,
    (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.queuedMessageId') END) AS queued_message_id,
    ${at('send.item_id')} AS opener_sequence,${at('send.provider_item_id')} AS provider_sequence,
    ${at("(CASE WHEN json_valid(send.payload_json) THEN json_extract(send.payload_json,'$.answeredInTurn.turnItemId') END)")} AS answered_sequence
    FROM journal_submission_attempts send WHERE session_id=? AND epoch=? AND current=1 ORDER BY ordinal`)
    .all(...scope.prefix)
    .map((row) => {
      const read = scope.examined(row)
      return {
        messageId: String(read.message_id),
        itemId: String(read.item_id),
        ordinal: Number(read.ordinal),
        dispatchState: String(read.dispatch_state),
        recovered: Number(read.recovered) === 1,
        providerItemId: read.provider_item_id === null ? null : String(read.provider_item_id),
        queuedMessageId: read.queued_message_id === null ? null : String(read.queued_message_id),
        submittedSequence:
          read.submitted_sequence === null ? null : Number(read.submitted_sequence),
        positions: [read.opener_sequence, read.provider_sequence, read.answered_sequence].flatMap(
          (value) => (value === null || value === undefined ? [] : [Number(value)])
        )
      }
    })
}

function readSend(scope: JournalSqlScope, messageId: string): AgentJournalSubmission {
  const row = scope.db
    .prepare(`SELECT payload_json FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
    .get(...scope.prefix, messageId)
  if (!row) {
    throw new Error('journal send left between its selector and payload reads')
  }
  return scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json)
}

/** Handed over and not answered: its turn is still to be attributed. */
function unanswered(send: Send): boolean {
  return send.dispatchState === 'pending' || (send.dispatchState === 'unknown' && !send.recovered)
}

/** The sends the window holds: anchored, unanswered or placed in it, with every send sharing a
 *  provider id or queued card with one, since attribution reads the first or last of those. */
function keptSends(
  sends: readonly Send[],
  operations: ReadonlySet<string>,
  start: number | null,
  anchorsOnly: boolean
): Send[] {
  const after = (position: number) => start !== null && position >= start
  const kept = new Set(
    sends.filter(
      (send) =>
        operations.has(send.messageId) ||
        send.positions.some(after) ||
        (unanswered(send) && (!anchorsOnly || send.positions.every(after)))
    )
  )
  for (let grown = true; grown;) {
    grown = false
    const providers = new Set([...kept].flatMap((send) => send.providerItemId ?? []))
    const cards = new Set([...kept].flatMap((send) => send.queuedMessageId ?? []))
    for (const send of sends) {
      if (
        !kept.has(send) &&
        ((send.providerItemId !== null && providers.has(send.providerItemId)) ||
          (send.queuedMessageId !== null && cards.has(send.queuedMessageId)))
      ) {
        kept.add(send)
        grown = true
      }
    }
  }
  return sends.filter((send) => kept.has(send))
}

/** Each operation's sends (its own id, every send that carried it as a queued card, and the card's
 *  latest consumption), and the sends an anchored row is the opener or provider row of. */
function resolveOperations(
  scope: JournalSqlScope,
  sends: readonly Send[],
  anchors: JournalOperationWindowAnchors
): Set<string> {
  const rows = new Set(anchors.itemIds)
  const ids = new Set(
    sends.flatMap((send) =>
      rows.has(send.itemId) || (send.providerItemId !== null && rows.has(send.providerItemId))
        ? [send.messageId]
        : []
    )
  )
  for (const operationId of anchors.operationIds ?? []) {
    const consumedAs = journalDomainQueueRow(scope.db, scope, operationId)?.card.consumedAs
    for (const send of sends) {
      if (
        send.messageId === operationId ||
        send.queuedMessageId === operationId ||
        send.messageId === consumedAs
      ) {
        ids.add(send.messageId)
      }
    }
  }
  return ids
}

/** Root turn rows that name the send's opener or provider id as theirs. */
function openedTurnPositions(scope: JournalSqlScope, send: Send): number[] {
  return [
    agentJournalSubmissionKey(send.messageId),
    ...(send.providerItemId ? [send.providerItemId] : [])
  ]
    .flatMap((key) =>
      scope.db
        .prepare(`SELECT sequence FROM journal_items INDEXED BY journal_items_opener
        WHERE session_id=? AND epoch=? AND hidden=0 AND opener_item_id=? AND root=1 AND turn_id IS NOT NULL`)
        .all(...scope.prefix, key)
    )
    .map((row) => Number(scope.examined(row).sequence))
}

function anchorPositions(scope: JournalSqlScope, anchors: JournalOperationWindowAnchors): number[] {
  const rows: SqliteRow[] = []
  // An id a provider echo named reads as the row the journal keeps it under (a Claude opener).
  const item = scope.db.prepare(`SELECT sequence,opener_item_id FROM journal_items
    WHERE session_id=? AND epoch=? AND hidden=0 AND item_id=COALESCE(
      (SELECT item_id FROM journal_item_aliases WHERE session_id=? AND epoch=? AND provider_item_id=?),?)`)
  const itemAt = (itemId: string) => item.get(...scope.prefix, ...scope.prefix, itemId, itemId)
  for (const itemId of anchors.itemIds ?? []) {
    const row = itemAt(itemId)
    rows.push(...(row ? [row] : []))
  }
  for (const turnId of anchors.turnIds ?? []) {
    rows.push(
      ...scope.db
        .prepare(`SELECT sequence,opener_item_id FROM journal_items INDEXED BY journal_items_named_turn
        WHERE session_id=? AND epoch=? AND hidden=0 AND turn_id=?`)
        .all(...scope.prefix, turnId)
    )
  }
  if (anchors.latestEndedTurn) {
    const row = scope.db
      .prepare(`SELECT sequence,opener_item_id FROM journal_items INDEXED BY journal_items_kind
      WHERE session_id=? AND epoch=? AND hidden=0 AND kind='turn' AND lifecycle_state IS NOT 'running'
      ORDER BY COALESCE(turn_completed_at,0) DESC,sequence DESC,sequence_index DESC,ordinal DESC LIMIT 1`)
      .get(...scope.prefix)
    rows.push(...(row ? [row] : []))
  }
  const positions = rows.flatMap((row) => {
    scope.examined(row)
    // A turn's prompt sits ahead of it, sometimes ahead of the turn before.
    const opener =
      typeof row.opener_item_id === 'string' ? itemAt(row.opener_item_id)?.sequence : undefined
    return [Number(row.sequence), ...(opener === undefined ? [] : [Number(opener)])]
  })
  if (anchors.latestTurns !== undefined) {
    const turns = scope.db
      .prepare(`SELECT sequence FROM journal_items INDEXED BY journal_items_status_turn
      WHERE session_id=? AND epoch=? AND hidden=0 AND turn_id IS NOT NULL AND root=1
      ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT ?`)
      .all(...scope.prefix, anchors.latestTurns)
    positions.push(turns.length < anchors.latestTurns ? 0 : Number(turns.at(-1)!.sequence))
  }
  if (anchors.afterSequence !== undefined) {
    positions.push(anchors.afterSequence + 1)
  }
  if (anchors.observedSince !== undefined) {
    positions.push(observedSincePosition(scope, anchors.observedSince))
  }
  return positions
}

/** Root turns newest first until one began before the time: rows from it on hold every later one. */
function observedSincePosition(scope: JournalSqlScope, since: number): number {
  let before: [number, number, number] = [Number.MAX_SAFE_INTEGER, 0, 0]
  for (;;) {
    const rows = scope.db
      .prepare(`SELECT sequence,sequence_index,ordinal,payload_json FROM journal_items
      INDEXED BY journal_items_status_turn WHERE session_id=? AND epoch=? AND hidden=0
      AND turn_id IS NOT NULL AND root=1 AND (sequence,sequence_index,ordinal)<(?,?,?)
      ORDER BY sequence DESC,sequence_index DESC,ordinal DESC LIMIT 64`)
      .all(...scope.prefix, ...before)
    for (const row of rows) {
      const turn = scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json)
      if (turn.observedAt < since) {
        return turn.sequence
      }
    }
    if (rows.length < 64) {
      return 0
    }
    const last = rows.at(-1)!
    before = [Number(last.sequence), Number(last.sequence_index), Number(last.ordinal)]
  }
}

/** The prompt ahead of the root turn before `sequence`: a held turn's predecessor and its opener. */
function marginBefore(scope: JournalSqlScope, sequence: number): number {
  const turn = scope.db
    .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items INDEXED BY journal_items_status_turn
    WHERE session_id=? AND epoch=? AND hidden=0 AND turn_id IS NOT NULL AND root=1 AND sequence<?`)
    .get(...scope.prefix, sequence)?.sequence
  if (turn === null || turn === undefined) {
    return 0
  }
  const user = scope.db
    .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items INDEXED BY journal_items_root_position
    WHERE session_id=? AND epoch=? AND hidden=0 AND root=1 AND kind='message' AND message_role='user'
    AND sequence<?`)
    .get(...scope.prefix, Number(turn))?.sequence
  return user === null || user === undefined ? 0 : Number(user)
}
