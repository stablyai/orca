import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalRewindSelection = { itemId: string; provider: string; nativeId: string }
export type JournalRewindCut = {
  floor: number
  providerItemId: string
} & (
  | { beforeTurnId: string; keptTurnId: string | null }
  | { beforeMessage: { sessionId: string; uuid: string } }
)

/** Provider membership and placement suffice; transcript bodies never leave the database. */
export function planJournalDomainRewindCut(scope: JournalSqlScope, target: JournalRewindSelection) {
  const { db, prefix } = scope
  const floor = Number(
    db
      .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items
      INDEXED BY journal_items_context_clear
      WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1`)
      .get(...prefix)!.sequence ?? 0
  )
  const rows = db
    .prepare(`SELECT item.item_id,item.sequence,item.sequence_index,item.ordinal,
      item.turn_scope_kind,item.turn_item_id,
      CASE WHEN item.turn_id IS NOT NULL
        THEN COALESCE(json_extract(item.payload_json,'$.body.providerTurnId'),item.turn_id) END AS own_turn,
      CASE WHEN owner.turn_id IS NOT NULL
        THEN COALESCE(json_extract(owner.payload_json,'$.body.providerTurnId'),owner.turn_id) END AS scoped_turn,
      CASE WHEN send.dispatch_state='accepted'
        THEN json_extract(send.payload_json,'$.providerItemId') END AS provider_item_id,
      CASE WHEN send.dispatch_state='rejected' OR
        (send.dispatch_state='pending' AND json_extract(send.payload_json,'$.handoverRecorded')=1
          AND json_extract(send.payload_json,'$.handedOverAt') IS NULL) THEN 1 ELSE 0 END AS omitted
    FROM journal_items item INDEXED BY journal_items_visible_position
    LEFT JOIN journal_items owner ON owner.session_id=item.session_id AND owner.epoch=item.epoch
      AND owner.item_id=item.turn_item_id
    LEFT JOIN journal_submission_attempts send ON send.session_id=item.session_id AND send.epoch=item.epoch
      AND send.item_id=item.item_id AND send.current=1
    WHERE item.session_id=? AND item.epoch=? AND item.hidden=0
    ORDER BY item.sequence,item.sequence_index,item.ordinal`)
    .all(...prefix)
    .map((row) => {
      scope.examined(row)
      const itemId = String(row.item_id)
      const providerItemId = row.provider_item_id === null ? itemId : String(row.provider_item_id)
      const identity = parseAgentJournalItemKey(providerItemId)
      return {
        itemId,
        sequence: Number(row.sequence),
        identity,
        providerItemId,
        omitted: Boolean(row.omitted),
        scopedTurn: row.turn_scope_kind === 'turn' ? String(row.turn_item_id) : undefined,
        turn:
          identity?.provider === 'codex' && identity.threadId === target.nativeId
            ? identity.turnId
            : row.turn_scope_kind === 'turn'
              ? row.scoped_turn === null
                ? undefined
                : String(row.scoped_turn)
              : row.own_turn === null
                ? undefined
                : String(row.own_turn)
      }
    })
  const active = rows.filter((row) => row.sequence > floor)
  const selected = active.find((row) => row.itemId === target.itemId)
  const key = selected?.identity
  if (!selected || !key || (key.provider !== 'claude' && key.provider !== 'codex')) {
    return null
  }
  const claude = key.provider === 'claude' && target.provider === 'claude'
  if (
    !claude &&
    (key.provider !== 'codex' || target.provider !== 'codex' || key.threadId !== target.nativeId)
  ) {
    return null
  }
  const boundary = active.findIndex((row) =>
    claude
      ? row.itemId === target.itemId
      : row.turn === (key.provider === 'codex' ? key.turnId : undefined)
  )
  const membership = (row: (typeof rows)[number]) => (claude ? row.scopedTurn : row.turn)
  const keptTurns = new Set(active.slice(0, boundary).flatMap((row) => membership(row) ?? []))
  const kept = new Set(
    active.flatMap((row, index) => {
      const turn = membership(row)
      return !row.omitted && (index < boundary || (turn !== undefined && keptTurns.has(turn)))
        ? [row.itemId]
        : []
    })
  )
  let cut: JournalRewindCut
  if (claude && key.provider === 'claude') {
    cut = {
      floor,
      providerItemId: selected.providerItemId,
      beforeMessage: { sessionId: key.sessionId, uuid: key.uuid }
    }
  } else if (key.provider === 'codex') {
    const seen = new Set<string>()
    let keptTurnId: string | null = null
    for (const row of rows) {
      const identity = row.identity
      if (
        (row.sequence <= floor || kept.has(row.itemId)) &&
        identity?.provider === 'codex' &&
        identity.threadId === key.threadId &&
        !seen.has(identity.turnId)
      ) {
        seen.add(identity.turnId)
        keptTurnId = identity.turnId
      }
    }
    cut = { floor, providerItemId: selected.providerItemId, beforeTurnId: key.turnId, keptTurnId }
  } else {
    return null
  }
  return { cut, kept, rows }
}
