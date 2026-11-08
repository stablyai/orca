import { isAgentSessionRewindTarget } from '../../../shared/agent-session/lifecycle/agent-session-rewind'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalContextEpoch } from './context-epochs/journal-context-cursor'
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
  return {
    cursor: { epoch, sequence: Number(head.last_sequence) },
    floor,
    sequence: selected?.sequence ?? null,
    eligible: Boolean(
      selected &&
      (!floor || selected.sequence > floor.sequence) &&
      isAgentSessionRewindTarget(
        selected,
        (turnItemId) => readAgentJournalTurn(item(turnItemId)?.body)?.userItemId
      )
    )
  }
}
