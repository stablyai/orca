// What a restart offer reads from a settled chat: its newest turn and the rows settlement rewrote in
// it. Indexed reads on the reader, so a long chat sends main a few rows, not its transcript.

import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { isRootAgentJournalItem } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import { isStructuredAgentSessionCommandTurn } from '../../../shared/agent-session/requests/structured-agent-session-command-entry'
import { isAgentSessionContextClear } from '../../../shared/agent-session/conversation-context/agent-session-context-clear'
import { readJournalStoredItem } from './journal-stored-output-rows'
import { journalDomainContextHead } from './journal-sql-continuation-context'

export type JournalRestartCut = {
  cursor: AgentJournalCursor
  /** The newest root turn since the last clear, commands aside. */
  turn: AgentJournalRenderItem | null
  /** A person's message came after that turn: the chat moved on. */
  movedOn: boolean
  /** That turn's own row and its rows, when a restart's settlement rewrote them. */
  recovered: AgentJournalRenderItem[]
}

export function readJournalDomainRestartCut(
  db: Database.Database,
  target: { sessionId: string; epoch: string }
): JournalRestartCut {
  const prefix = [target.sessionId, target.epoch] as const
  const cursor = journalDomainContextHead(db, target)
  const bodyOf = (itemId: string) => {
    const row = db
      .prepare(`SELECT payload_json FROM journal_items
      WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
      .get(...prefix, itemId)
    return row ? readJournalStoredItem(db, prefix, row.payload_json).body : null
  }
  let found: { item: AgentJournalRenderItem; sequence: number; sequenceIndex: number } | null = null
  for (const row of db
    .prepare(`SELECT payload_json, sequence, sequence_index FROM journal_items
    INDEXED BY journal_items_turn_marker
    WHERE session_id=? AND epoch=? AND hidden=0 AND turn_marker=1
    ORDER BY sequence DESC, sequence_index DESC, ordinal DESC`)
    .iterate(...prefix)) {
    const item = readJournalStoredItem(db, prefix, row.payload_json)
    if (isAgentSessionContextClear(item.body)) {
      break
    }
    const turn = readAgentJournalTurn(item.body)
    if (
      turn &&
      isRootAgentJournalItem(item) &&
      !isStructuredAgentSessionCommandTurn(turn, bodyOf)
    ) {
      found = { item, sequence: Number(row.sequence), sequenceIndex: Number(row.sequence_index) }
      break
    }
  }
  if (!found) {
    return { cursor, turn: null, movedOn: false, recovered: [] }
  }
  const movedOn = Boolean(
    db
      .prepare(`SELECT 1 FROM journal_items INDEXED BY journal_items_user_message
      WHERE session_id=? AND epoch=? AND hidden=0 AND kind='message' AND message_role='user'
        AND (sequence, sequence_index) > (?, ?) LIMIT 1`)
      .get(...prefix, found.sequence, found.sequenceIndex)
  )
  const recovered = db
    .prepare(`SELECT payload_json FROM journal_items INDEXED BY journal_items_stop_turn
    WHERE session_id=? AND epoch=? AND hidden=0 AND turn_item_id=?
      AND payload_json LIKE '%"recovered":true%'`)
    .all(...prefix, found.item.itemId)
    .map((row) => readJournalStoredItem(db, prefix, row.payload_json))
  return {
    cursor,
    turn: found.item,
    movedOn,
    recovered: found.item.recovered ? [found.item, ...recovered] : recovered
  }
}
