import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type { JournalSqlScope } from './journal-sql-scope'
import { boundedStoredJson, boundedStoredJsonSql } from './journal-stored-json-bounds'

// A Diff call's patch, and so the files it edited, is its output: that one is kept.
const WITHOUT_TOOL_OUTPUT = `CASE WHEN kind='tool-call' AND json_valid(payload_json)
  AND json_extract(payload_json,'$.body.name') IS NOT 'Diff'
  THEN json_replace(payload_json,'$.body.output.head','','$.body.output.truncated',json('true'))
  ELSE payload_json END`

/** A window row sized in SQL first: one too large for a reply comes back with its output cut. */
export function operationWindowRowSql(withoutToolOutput = false): string {
  return boundedStoredJsonSql(
    withoutToolOutput ? WITHOUT_TOOL_OUTPUT : 'payload_json',
    'payload_json',
    {
      bytes: 'octet_length(payload_json)',
      shortenColumn: 'payload_json'
    }
  )
}

export function operationWindowItem(
  scope: JournalSqlScope,
  row: SqliteRow
): AgentJournalRenderItem {
  return scope.decode<AgentJournalRenderItem>(
    boundedStoredJson(scope.examined(row), 'payload_json')
  )
}
