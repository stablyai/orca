import { decodePersistedAgentSessionRecord } from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { isReadableAgentSessionStoreRecord } from '../../runtime/agent-session/records/agent-session-store-row-rules'
import { isAgentSessionRewindTarget } from '../../../shared/agent-session/lifecycle/rewind/agent-session-rewind'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalContextEpoch } from './context-epochs/journal-context-epoch'
import type { JournalSqlScope } from './journal-sql-scope'

export type JournalRewindTarget = {
  cursor: AgentJournalCursor
  floor: AgentJournalCursor | null
  sequence: number | null
  eligible: boolean
}

/** Admission reads the target, its containing turn and the clear floor in one snapshot. */
export function readJournalDomainRewindTarget(
  scope: JournalSqlScope,
  itemId: string
): JournalRewindTarget {
  const head = scope.db
    .prepare(`SELECT last_sequence,context_boundary FROM journal_chat_state
      WHERE session_id=? AND epoch=?`)
    .get(...scope.prefix)!
  scope.examined(head)
  const epoch = journalContextEpoch(scope.epoch, Number(head.context_boundary))
  const cleared = scope.db
    .prepare(`SELECT sequence FROM journal_items INDEXED BY journal_items_context_clear
      WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1
      ORDER BY sequence DESC LIMIT 1`)
    .get(...scope.prefix)
  const floor = cleared ? { epoch, sequence: Number(scope.examined(cleared).sequence) } : null
  const item = (key: string): AgentJournalRenderItem | undefined => {
    const row = scope.db
      .prepare(`SELECT payload_json FROM journal_items
        WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
      .get(...scope.prefix, key)
    return row ? scope.decode<AgentJournalRenderItem>(scope.examined(row).payload_json) : undefined
  }
  const selected = item(itemId)
  const raw = scope.db
    .prepare('SELECT record_json FROM agent_session_records WHERE session_id=?')
    .get(scope.sessionId)
  const stored: unknown = raw && JSON.parse(String(raw.record_json))
  const boundary = isReadableAgentSessionStoreRecord(scope.sessionId, stored)
    ? decodePersistedAgentSessionRecord(stored).record.forkedFrom?.childBoundary
    : undefined
  const inherited =
    boundary?.kind === 'item' &&
    scope.db
      .prepare(`SELECT 1 FROM journal_items selected
    CROSS JOIN journal_items anchor WHERE selected.session_id=? AND selected.epoch=? AND selected.item_id=? AND selected.hidden=0
    AND anchor.session_id=selected.session_id AND anchor.epoch=selected.epoch AND anchor.item_id=? AND anchor.hidden=0
    AND (selected.sequence,selected.sequence_index,selected.ordinal)<=(anchor.sequence,anchor.sequence_index,anchor.ordinal)`)
      .get(...scope.prefix, itemId, boundary.itemId) !== undefined
  return {
    cursor: { epoch, sequence: Number(head.last_sequence) },
    floor,
    sequence: selected?.sequence ?? null,
    eligible: Boolean(
      selected &&
      !inherited &&
      (!floor || selected.sequence > floor.sequence) &&
      isAgentSessionRewindTarget(
        selected,
        (turnItemId) => readAgentJournalTurn(item(turnItemId)?.body)?.userItemId
      )
    )
  }
}
