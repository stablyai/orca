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
    case 'boundary':
      predicates.push('(turn_id IS NOT NULL OR context_clear=1)')
      single = true
      break
    case 'turns':
      predicates.push('turn_id IS NOT NULL')
      if (selection.root) {
        predicates.push('root=1')
      }
      ascending = selection.direction === 'asc'
      break
    case 'prompt':
    case 'users':
      predicates.push("root=1 AND message_role='user' AND command_entry=0")
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
          ? "root=1 AND kind='tool-call' AND lifecycle_state='running'"
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
      .prepare(`SELECT entry_key,sequence,sequence_index,ordinal
      FROM journal_proj_items WHERE ${predicates.join(' AND ')}${cursor}
      ${unordered ? '' : `ORDER BY ${order}`} LIMIT ?`)
      .all(...params, ...(after ?? []), single ? 1 : PAGE)
    for (const row of rows) {
      scope.examined(row)
    }
    for (const row of rows) {
      const current = item(String(JSON.parse(String(row.entry_key))))
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
