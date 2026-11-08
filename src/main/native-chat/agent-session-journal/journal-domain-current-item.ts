import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { journalDomainHistoryMetadata } from './journal-domain-history-metadata'
import { writeJournalDomainItemNames } from './journal-domain-item-names'
import { journalDomainStopNote, refreshJournalDomainStopNotes } from './journal-domain-stop-notes'

export type JournalDomainCurrentItemWrite = {
  item: AgentJournalRenderItem
  previous?: { item: AgentJournalRenderItem; ordinal: number; hidden: boolean }
  ordinal: number
  hidden: boolean
  ownerFence: number
  executionOwner?: number | null
}

/** The owning command chooses revision, placement and authority before its one event append. */
export function writeJournalDomainCurrentItem(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  input: JournalDomainCurrentItemWrite
): AgentJournalRenderItem[] {
  if (!db.isTransaction) {
    throw new Error('journal item persistence requires its writer transaction')
  }
  const prefix = [target.sessionId, target.epoch] as const
  const stopNote = journalDomainStopNote(input.item, (id) => {
    if (id === input.item.itemId) {
      return input.item
    }
    const row = db
      .prepare(`SELECT payload_json FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=COALESCE(
          (SELECT item_id FROM journal_item_aliases
            WHERE session_id=? AND epoch=? AND provider_item_id=?),?)`)
      .get(...prefix, ...prefix, id, id)
    return row ? JSON.parse(String(row.payload_json)) : undefined
  })
  const next = stopNote.item
  const payload = JSON.stringify(next)
  const metadata = journalDomainHistoryMetadata(next, payload)
  db.prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,sequence,sequence_index,owner_fence,execution_owner,payload_json,
      hidden,root,subagent_row,subagent_group_key,turn_marker,wire_bytes,turn_item_id,original_stop_note_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,epoch,item_id) DO UPDATE SET
      ordinal=excluded.ordinal, revision=excluded.revision, sequence=excluded.sequence, sequence_index=excluded.sequence_index,
      owner_fence=excluded.owner_fence, execution_owner=excluded.execution_owner, payload_json=excluded.payload_json,
      hidden=excluded.hidden, root=excluded.root, subagent_row=excluded.subagent_row, subagent_group_key=excluded.subagent_group_key,
      turn_marker=excluded.turn_marker, wire_bytes=excluded.wire_bytes,
      turn_item_id=excluded.turn_item_id, original_stop_note_json=excluded.original_stop_note_json`).run(
    ...prefix,
    next.itemId,
    input.ordinal,
    next.revision,
    next.sequence,
    next.sequenceIndex ?? 0,
    input.ownerFence,
    input.executionOwner ?? null,
    payload,
    Number(input.hidden),
    metadata.root,
    metadata.subagentRow,
    metadata.subagentGroupKey,
    metadata.turnMarker,
    metadata.wireBytes,
    stopNote.turnItemId,
    stopNote.originalStopNoteJson
  )
  writeJournalDomainItemNames(
    db,
    target,
    next,
    { ordinal: input.ordinal, hidden: input.hidden },
    metadata.namedSubagentIds,
    input.previous
  )
  return [
    next,
    ...(readAgentJournalTurn(next.body) || readAgentJournalTurn(input.previous?.item.body)
      ? refreshJournalDomainStopNotes(db, target, [next.itemId])
      : [])
  ]
}
