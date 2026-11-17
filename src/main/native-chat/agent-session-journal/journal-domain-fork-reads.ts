import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { journalDomainContextHead } from './journal-sql-continuation-context'
import type { JournalSqlScope } from './journal-sql-scope'
import type { SqliteRow } from '../../sqlite/sqlite-statement'

export type JournalForkBoundary = {
  snapshot: AgentJournalSnapshot
  submissionsToken: string | null
}
export type JournalSavedContent = 'content' | 'uncertain' | 'empty'

/** A fork needs its selected row, containing turn, next boundary and inherited anchor, never the transcript. */
export function readJournalDomainForkBoundary(
  scope: JournalSqlScope,
  itemId: string,
  inheritedAnchor: string | undefined,
  compareSubmissions: boolean
): JournalForkBoundary {
  const { db, prefix } = scope
  const cursor = journalDomainContextHead(db, scope)
  const floor = Number(
    db
      .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items
    INDEXED BY journal_items_context_clear WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1`)
      .get(...prefix)!.sequence ?? 0
  )
  const selected = db
    .prepare(`SELECT item_id,sequence,sequence_index,ordinal,placement_json,
      revision,turn_item_id FROM journal_items
      WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND root=1
      AND kind='message' AND message_role='assistant' AND sequence>?`)
    .get(...prefix, itemId, floor)
  const items = new Map<string, { row: SqliteRow; item: AgentJournalRenderItem }>()
  const retain = (row: SqliteRow, role: 'user' | 'assistant' = 'assistant') => {
    scope.examined(row)
    const item: AgentJournalRenderItem =
      row.payload_json === undefined || row.payload_json === null
        ? {
            ...scope.decode<Omit<AgentJournalRenderItem, 'body'>>(row.placement_json),
            sequence: Number(row.sequence),
            revision: Number(row.revision),
            body: { kind: 'message', role, blocks: [] }
          }
        : scope.decode<AgentJournalRenderItem>(row.payload_json)
    items.set(item.itemId, { row, item })
    return item
  }
  if (selected) {
    retain(selected)
    if (selected.turn_item_id !== null) {
      const root = db
        .prepare(`SELECT item_id,sequence,sequence_index,ordinal,payload_json
        FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND sequence>?`)
        .get(...prefix, String(selected.turn_item_id), floor)
      if (root) {
        retain(root)
      }
    }
    const next = db
      .prepare(`SELECT item_id,sequence,sequence_index,ordinal,placement_json,revision,
      CASE WHEN turn_marker=1 THEN payload_json END AS payload_json
      FROM journal_items INDEXED BY journal_items_root_position
      WHERE session_id=? AND epoch=? AND hidden=0 AND root=1
        AND (sequence,sequence_index,ordinal)>(?,?,?)
        AND ((turn_marker=1 AND item_id<>?) OR (kind='message' AND message_role='user'
          AND (turn_scope_kind IS NULL OR turn_scope_kind<>'turn')
          AND NOT EXISTS(SELECT 1 FROM json_each(payload_json,'$.body.blocks') block
            WHERE json_extract(block.value,'$.type')='tool-result')))
      ORDER BY sequence,sequence_index,ordinal LIMIT 1`)
      .get(
        ...prefix,
        Number(selected.sequence),
        Number(selected.sequence_index),
        Number(selected.ordinal),
        selected.turn_item_id === null ? '' : String(selected.turn_item_id)
      )
    if (next) {
      retain(next, 'user')
    }
    if (inheritedAnchor && !items.has(inheritedAnchor)) {
      const anchor = db
        .prepare(`SELECT item_id,sequence,sequence_index,ordinal,revision,placement_json
        FROM journal_items WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0 AND sequence>?`)
        .get(...prefix, inheritedAnchor, floor)
      if (anchor) {
        retain(anchor)
      }
    }
  }
  const keys = new Set<string>()
  for (const { item } of items.values()) {
    keys.add(item.itemId)
    const opener = readAgentJournalTurn(item.body)?.userItemId
    if (opener) {
      keys.add(opener)
    }
  }
  const submissions = db
    .prepare(`SELECT send.payload_json FROM json_each(?) wanted
    CROSS JOIN journal_submission_attempts send
    WHERE send.session_id=? AND send.epoch=? AND send.current=1 AND send.item_id=wanted.value
    ORDER BY send.ordinal`)
    .all(JSON.stringify([...keys]), ...prefix)
    .map((row) => scope.decode<AgentJournalSubmission>(scope.examined(row).payload_json))
  let submissionsToken: string | null = null
  if (compareSubmissions) {
    const row = db
      .prepare('SELECT submissions_revision FROM journal_chat_state WHERE session_id=? AND epoch=?')
      .get(...prefix)!
    submissionsToken = JSON.stringify([scope.epoch, Number(row.submissions_revision)])
  }
  return {
    snapshot: {
      sessionId: scope.sessionId,
      cursor,
      submissions,
      items: [...items.values()]
        .sort(
          (a, b) =>
            Number(a.row.sequence) - Number(b.row.sequence) ||
            Number(a.row.sequence_index) - Number(b.row.sequence_index) ||
            Number(a.row.ordinal) - Number(b.row.ordinal)
        )
        .map(({ item }) => item)
    },
    submissionsToken
  }
}

/** Native identities or accepted sends prove content; write-ahead rows alone do not. */
export function readJournalDomainSavedContent(scope: JournalSqlScope): JournalSavedContent {
  let uncertain = false
  for (const row of scope.db
    .prepare(`SELECT item.item_id,send.dispatch_state,
      json_extract(send.payload_json,'$.handoverRecorded') AS handover,
      json_extract(send.payload_json,'$.handedOverAt') AS handed_over_at
    FROM journal_items item INDEXED BY journal_items_kind
    LEFT JOIN journal_submission_attempts send ON send.session_id=item.session_id AND send.epoch=item.epoch
      AND send.item_id=item.item_id AND send.current=1
    WHERE item.session_id=? AND item.epoch=? AND item.hidden=0 AND item.kind='message'
      AND item.message_role IN ('user','assistant')`)
    .iterate(...scope.prefix)) {
    scope.examined(row)
    const identity = parseAgentJournalItemKey(String(row.item_id))
    if (row.dispatch_state === 'accepted' || (identity && identity.provider !== 'orca')) {
      return 'content'
    }
    uncertain ||=
      row.dispatch_state === null ||
      row.dispatch_state === 'unknown' ||
      (row.dispatch_state === 'pending' && (!row.handover || row.handed_over_at !== null))
  }
  return uncertain ? 'uncertain' : 'empty'
}
