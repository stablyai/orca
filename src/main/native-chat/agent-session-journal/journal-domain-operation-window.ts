import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import type { JournalSqlScope } from './journal-sql-scope'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { readOperationWindowItems } from './journal-operation-window-rows'
import { marginAfter } from './journal-operation-window-end'
import {
  type Send,
  newestTurnsOnly,
  keptSends,
  reachesBefore,
  recentSends,
  readSend,
  seedSends,
  sendHeads,
  unanswered,
  windowSends,
  withSends
} from './journal-operation-window-sends'

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
  /** With `operationIds` alone, for a reader of the anchored operations' own turns: the window ends where the next root turn
   *  opens, and only the anchored operations' sends and those placed inside the window are read, so
   *  its cost never grows with the chat after them. Unanswered sends outside it do not come along. */
  throughAnchoredTurns?: boolean
  /** Only the rows that say who opened and ran each turn: messages, turn and status rows, and any
   *  row of no known turn (it ends a turn's reach); never tool calls or diffs. */
  turnShape?: boolean
}

export type JournalOperationWindow = {
  snapshot: AgentJournalSnapshot
  /** The window starts at the conversation's first row, so it holds everything. */
  complete: boolean
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
  // A window through its anchored turns reads only the sends it can hold, each found by index, so
  // opening one old turn costs the same however many sends the chat has made since.
  const bounded = anchors.throughAnchoredTurns === true
  if (
    bounded &&
    (anchors.itemIds?.length ||
      anchors.turnIds?.length ||
      anchors.latestEndedTurn ||
      anchors.latestTurns !== undefined ||
      anchors.afterSequence !== undefined ||
      anchors.observedSince !== undefined)
  ) {
    throw new Error('a window through its anchored turns is anchored by operation ids alone')
  }
  // A window of the newest turns alone reads the sends placed in it and the unsettled ones, each by
  // index, so reading whom the newest turn acts for costs the same however long the chat ran before.
  const recent = !bounded && newestTurnsOnly(anchors)
  let indexed = bounded || recent
  let sends = seedSends(scope, anchors, recent)
  const operations = resolveOperations(scope, sends, anchors)
  // Where each anchored send's own turn may reach: past the first turn after it when it names its
  // turn (a turn row naming it, or its answeredInTurn), past the second when it doesn't (an older
  // import, placed by position, whose own turn may be that first one).
  const reaches: { last: number; placed: boolean }[] = []
  const anchorAt = anchorPositions(scope, anchors)
  const anchored = [
    ...sends.flatMap((send) => {
      if (operations.has(send.messageId)) {
        const turns = openedTurnPositions(scope, send)
        const at = [...send.positions, ...turns]
        if (at.length > 0) {
          reaches.push({
            last: Math.max(...at),
            placed: turns.length > 0 || send.answeredSequence !== null
          })
        }
        // Nothing of it is saved where a reading can place it: only the whole conversation answers.
        return at.length > 0 ? at : send.submittedSequence !== null ? [send.submittedSequence] : [0]
      }
      return unanswered(send) && !anchors.anchorsOnly ? send.positions : []
    }),
    ...anchorAt
  ]
  const earliest = anchored.length > 0 ? Math.min(...anchored) : null
  const fresh = recent
    ? recentSends(scope, sends, operations, earliest, Math.min(...anchorAt), !!anchors.anchorsOnly)
    : sends
  if (fresh === null) {
    indexed = false
  }
  sends = fresh ?? sendHeads(scope)
  let start =
    earliest === null ? null : anchors.withoutTurnAhead ? earliest : marginBefore(scope, earliest)
  const end = earliest !== null && bounded ? windowEnd(scope, reaches) : null
  if (indexed && start !== null) {
    // A newest-turns window stops reading a family at its first member older than the window: the
    // window must widen to it, which the whole read below answers.
    const older = (send: Send) => recent && reachesBefore([send], null, start ?? Infinity)
    const placed = windowSends(scope, start, end ?? Number.MAX_SAFE_INTEGER)
    sends = withSends(scope, sends, placed, older)
  }
  let kept: Send[] = []
  // A held send's own rows, and the head it was sent at, are held too: a turn may claim a send by
  // that position. No margin here, so the window never walks back a turn per held send.
  for (;;) {
    kept = keptSends(sends, operations, start, end, anchors.anchorsOnly === true)
    const reach = kept.flatMap((send) => [
      ...send.positions,
      ...(send.submittedSequence !== null ? [send.submittedSequence] : [])
    ])
    const next = reach.length > 0 ? Math.min(start ?? Infinity, ...reach) : start
    if (next === null || (start !== null && next >= start)) {
      break
    }
    if (recent && indexed) {
      // Widening a newest-turns window means a long stretch: one whole read is cheaper.
      indexed = false
      sends = sendHeads(scope)
    } else if (indexed && start !== null) {
      // The sends placed in the stretch the window just took on.
      sends = withSends(scope, sends, windowSends(scope, next, start))
    }
    start = next
  }
  const items = start === null ? [] : readOperationWindowItems(scope, start, anchors, end)
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
    complete:
      end === null &&
      (first === null || first === undefined || (start !== null && start <= Number(first)))
  }
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

/** The furthest any anchored send's own turn may reach; null (the head) when one may reach it. */
function windowEnd(
  scope: JournalSqlScope,
  reaches: readonly { last: number; placed: boolean }[]
): number | null {
  let end = 0
  for (const { last, placed } of reaches) {
    const after = marginAfter(scope, last)
    const reach = after !== null && !placed ? marginAfter(scope, after) : after
    if (reach === null) {
      return null
    }
    end = Math.max(end, reach)
  }
  return reaches.length > 0 ? end : null
}
