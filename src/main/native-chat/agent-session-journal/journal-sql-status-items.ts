import type { SqliteRow } from '../../sqlite/sqlite-statement'
import { AGENT_SESSION_ITEM_WIRE_VERSION } from '../agent-session-wire/publication/history/agent-session-item-presentation-contract'
import {
  readJournalDomainStopStates,
  resolveJournalDomainDisplay,
  journalDomainDisplayTurnState
} from './journal-domain-item-display'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalStatusItem, JournalStatusItemSelection } from './journal-status-items'

const PAGE = 128

/** Select current metadata in keyset pages, then decode only the reached candidates. */
export function* sqlJournalStatusItems(
  scope: JournalSqlScope,
  item: (itemId: string) => AgentJournalRenderItem | undefined,
  selection: JournalStatusItemSelection
): Iterable<JournalStatusItem> {
  const raw = selection.kind === 'boundary' && selection.raw
  const predicates = ['session_id=?', 'epoch=?', ...(raw ? [] : ['hidden=0'])]
  const params: (string | number)[] = [...scope.prefix]
  let ascending = false
  let single = false
  let unordered = false
  switch (selection.kind) {
    case 'clear':
      predicates.push('context_clear=1')
      single = true
      break
    case 'boundary':
      predicates.push('turn_marker=1')
      single = true
      break
    case 'turns':
      predicates.push('turn_id IS NOT NULL')
      if (selection.root) {
        predicates.push('root=1')
      }
      ascending = selection.direction === 'asc'
      single = selection.first === true
      if (selection.before !== undefined) {
        predicates.push('sequence<?')
        params.push(selection.before)
      }
      break
    case 'prompt':
    case 'users':
      predicates.push('prompt=1')
      if (selection.kind === 'users' && selection.unknown) {
        predicates.push("turn_scope_kind='unknown'")
      }
      single = selection.kind === 'prompt'
      break
    case 'assistant-prose':
      predicates.push(
        "root=1 AND message_role='assistant' AND command_entry=0 AND assistant_prose=1"
      )
      break
    case 'assistant-exists':
      predicates.push("message_role='assistant'")
      single = unordered = true
      break
    case 'pending-prompts':
      predicates.push("kind IN ('approval','question') AND lifecycle_state='pending'")
      ascending = true
      break
    case 'scoped-statuses':
      predicates.push("kind='status' AND turn_item_id=?")
      params.push(selection.turnItemId)
      ascending = true
      break
    case 'tools':
      predicates.push(
        selection.running
          ? "root=1 AND kind='tool-call' AND lifecycle_state='running' AND (lifecycle_state IN ('running','pending') OR live_work=1)"
          : "root=1 AND kind IN ('tool-call','diff')"
      )
      predicates.push('(sequence,sequence_index,ordinal)>(?,?,?)')
      params.push(selection.after.sequence, selection.after.sequenceIndex, selection.after.ordinal)
      single = true
      break
  }
  if ('floor' in selection && selection.floor) {
    predicates.push('sequence>?')
    params.push(selection.floor)
  }
  const columns = raw ? ['sequence', 'ordinal'] : ['sequence', 'sequence_index', 'ordinal']
  const order = columns.map((column) => `${column} ${ascending ? 'ASC' : 'DESC'}`).join(',')
  let after: number[] | undefined
  for (;;) {
    const cursor = after
      ? ` AND (${columns.join(',')})${ascending ? '>' : '<'}(${columns.map(() => '?').join(',')})`
      : ''
    const rows = scope.db
      .prepare(`SELECT item_id,sequence,sequence_index,ordinal
      FROM journal_items ${selection.kind === 'tools' && selection.running ? 'INDEXED BY journal_items_unsettled' : ''}
      WHERE ${predicates.join(' AND ')}${cursor}
      ${unordered ? '' : `ORDER BY ${order}`} LIMIT ?`)
      .all(...params, ...(after ?? []), single ? 1 : PAGE)
    for (const row of rows) {
      scope.examined(row)
    }
    for (const row of rows) {
      const current = item(String(row.item_id))
      if (current) {
        yield {
          item: current,
          position: {
            sequence: Number(row.sequence),
            sequenceIndex: Number(row.sequence_index),
            ordinal: Number(row.ordinal)
          }
        }
      }
    }
    const last = rows.at(-1)
    if (single || rows.length < PAGE || !last) {
      return
    }
    after = columns.map((column) => Number(last[column]))
  }
}

export function sqlJournalStatusItem(
  scope: JournalSqlScope,
  row: SqliteRow,
  id: string,
  states?: ReturnType<typeof readJournalDomainStopStates>
) {
  scope.examined(row)
  const item = scope.decode<AgentJournalRenderItem>(row.payload_json)
  const stopStates =
    row.wire_version === AGENT_SESSION_ITEM_WIRE_VERSION
      ? undefined
      : (states ?? readJournalDomainStopStates(scope.db, scope, [id]))
  const displayed = resolveJournalDomainDisplay(
    item,
    row.wire_version,
    row.wire_json,
    stopStates && journalDomainDisplayTurnState(item, stopStates)
  )
  return { item, displayed, hidden: Boolean(row.hidden), fence: Number(row.fence) }
}
