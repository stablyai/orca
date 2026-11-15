import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionForkedFrom } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import type { JournalSqlScope } from './journal-sql-scope'
import { readJournalDomainClientItems } from './journal-domain-item-presentation'
import {
  readJournalDomainStopStates,
  resolveJournalDomainDisplay,
  journalDomainDisplayTurnState
} from './journal-domain-item-display'
export type JournalPublicationRead =
  | {
      kind: 'fork-marker-group'
      boundary: AgentSessionForkedFrom['childBoundary']
      previousSequence?: number
    }
  | { kind: 'projected-stop-notes'; afterOrdinal: number; limit: number }

export type JournalPublicationReadResult =
  | { kind: 'fork-marker-group'; snapshot: AgentJournalSnapshot }
  | {
      kind: 'projected-stop-notes'
      items: AgentJournalRenderItem[]
      nextOrdinal: number | null
    }

/** Publication reads name exact groups or page only notes with retained original Stop facts. */
export function readJournalDomainPublication(
  scope: JournalSqlScope,
  operation: JournalPublicationRead
): JournalPublicationReadResult {
  const { db, prefix } = scope
  switch (operation.kind) {
    case 'fork-marker-group': {
      const head = db
        .prepare(`SELECT last_sequence,context_boundary FROM journal_chat_state
        WHERE session_id=? AND epoch=?`)
        .get(...prefix)!
      const boundary = operation.boundary
      const anchor =
        boundary.kind === 'item'
          ? db
              .prepare(`SELECT sequence FROM journal_items
          WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
              .get(...prefix, boundary.itemId)
          : { sequence: 0 }
      const sequences = [
        ...new Set([
          ...(anchor ? [Number(anchor.sequence)] : []),
          ...(operation.previousSequence === undefined ? [] : [operation.previousSequence])
        ])
      ]
      const rows = db
        .prepare(`SELECT item.item_id,item.wire_version,item.wire_json,item.payload_json FROM json_each(?) wanted
        CROSS JOIN journal_items item INDEXED BY journal_items_visible_position
        WHERE item.session_id=? AND item.epoch=? AND item.hidden=0 AND item.sequence=wanted.value
        ORDER BY item.sequence,item.sequence_index,item.ordinal`)
        .all(JSON.stringify(sequences), ...prefix)
      const states = readJournalDomainStopStates(
        db,
        scope,
        rows.map((row) => String(row.item_id))
      )
      return {
        kind: operation.kind,
        snapshot: {
          sessionId: scope.sessionId,
          cursor: {
            epoch: journalContextEpoch(scope.epoch, Number(head.context_boundary)),
            sequence: Number(head.last_sequence)
          },
          items: rows.map((row) => {
            const item = scope.decode<AgentJournalRenderItem>(row.payload_json)
            return resolveJournalDomainDisplay(
              item,
              row.wire_version,
              row.wire_json,
              journalDomainDisplayTurnState(item, states)
            )
          }),
          submissions: []
        }
      }
    }
    case 'projected-stop-notes': {
      const limit = Math.max(1, Math.min(128, Math.floor(operation.limit)))
      const rows = db
        .prepare(`SELECT ordinal,item_id FROM journal_items item
        INDEXED BY journal_items_original_stop_note
        WHERE session_id=? AND epoch=? AND hidden=0 AND original_stop_note_json IS NOT NULL
        AND ordinal>? ORDER BY ordinal LIMIT ?`)
        .all(...prefix, operation.afterOrdinal, limit)
      return {
        kind: operation.kind,
        items: readJournalDomainClientItems(
          db,
          scope,
          rows.map((row) => String(row.item_id))
        ).flatMap((item) => {
          return item.body.kind === 'status' && item.body.failure === undefined ? [item] : []
        }),
        nextOrdinal: rows.length === limit ? Number(rows.at(-1)!.ordinal) : null
      }
    }
  }
}
