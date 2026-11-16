import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalItemSubagentId } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import { namedSubagents } from '../../../shared/native-chat/transcript/subagents/native-chat-subagent-items'
import { offPageSubagentRoster } from '../agent-session-wire/publication/history/agent-session-history-subagent-roster'

/** One indexed lookup per unnamed page subagent finds its earliest visible naming row. */
export function readJournalDomainHistoryRoster(
  db: Database.Database,
  prefix: readonly [string, string],
  page: readonly AgentJournalRenderItem[]
) {
  const missing = new Set(page.map(agentJournalItemSubagentId).filter((id) => id !== null))
  for (const item of page) {
    if (item.agentId === undefined && item.body.kind === 'message') {
      for (const entry of item.body.blocks.flatMap(namedSubagents)) {
        missing.delete(entry.id)
      }
    }
  }
  if (missing.size === 0) {
    return undefined
  }
  const earliest = db.prepare(`SELECT item_id, sequence, sequence_index, ordinal
    FROM journal_item_subagent_names
    WHERE session_id=? AND epoch=? AND subagent_id=? AND hidden=0
    ORDER BY sequence, sequence_index, ordinal LIMIT 1`)
  const naming = new Map<string, [number, number, number]>()
  for (const id of missing) {
    const row = earliest.get(...prefix, id)
    if (row) {
      naming.set(String(row.item_id), [
        Number(row.sequence),
        Number(row.sequence_index),
        Number(row.ordinal)
      ])
    }
  }
  const body = db.prepare(
    'SELECT payload_json FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?'
  )
  const named = [...naming]
    .sort(([, a], [, b]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2])
    .slice(0, ROSTER_ROWS)
    .map(([itemId]) => JSON.parse(String(body.get(...prefix, itemId)!.payload_json)))
  return offPageSubagentRoster(named, page)
}

// The roster keeps at most 64 entries; each selected row adds at least one.
const ROSTER_ROWS = 64
