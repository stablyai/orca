import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { latestStructuredAgentSessionPrompt } from '../../../shared/agent-session/requests/structured-agent-session-latest-request'
import {
  journalStatusReportsSignedOut,
  readJournalOutgrownChild,
  readJournalRestartProgress,
  type JournalLifecycleSnapshot,
  type JournalOutgrownChild,
  type JournalOutgrownChildRead,
  type JournalRestartProgress
} from './journal-lifecycle-reads'
import { readJournalSqlInput } from './journal-sql-input-reads'
import type { JournalSqlItemReadContext } from './journal-sql-item-reads'
import { sqlJournalStatusItems } from './journal-sql-status-items'

export type JournalSqlLifecycleRead =
  | { kind: 'latest-prompt' }
  | { kind: 'restart-progress'; cursor: AgentJournalCursor }
  | { kind: 'outgrown-child'; input: JournalOutgrownChildRead }

export type JournalSqlLifecycleReadResult =
  | { kind: 'latest-prompt'; prompt: string }
  | { kind: 'restart-progress'; progress: JournalRestartProgress }
  | { kind: 'outgrown-child'; child: JournalOutgrownChild }

// Execution ownership wins over creation provenance, as journalItemExecutionFence reads it.
const ROOT_STATUSES_AT_FENCE = `SELECT item.entry_key FROM journal_proj_items item
  LEFT JOIN journal_proj_item_execution_owners owner ON owner.session_id=item.session_id
    AND owner.epoch=item.epoch AND owner.item_id=json_extract(item.entry_key, '$')
  LEFT JOIN journal_proj_item_fences created ON created.session_id=item.session_id
    AND created.epoch=item.epoch AND created.item_id=json_extract(item.entry_key, '$')
  WHERE item.session_id=? AND item.epoch=? AND item.kind='status' AND item.root=1
    AND item.hidden=0 AND coalesce(owner.fence, created.fence)=?`

/** Each answer comes from the one snapshot the point read opened; only named candidates decode. */
export function readJournalSqlLifecycle(
  context: JournalSqlItemReadContext,
  operation: JournalSqlLifecycleRead
): JournalSqlLifecycleReadResult {
  const { scope } = context
  if (operation.kind === 'latest-prompt') {
    const prompt = sqlJournalStatusItems(scope, context.item, { kind: 'prompt' })
      [Symbol.iterator]()
      .next().value?.item
    return {
      kind: 'latest-prompt',
      prompt: prompt ? latestStructuredAgentSessionPrompt([prompt]) : ''
    }
  }
  const snapshot: JournalLifecycleSnapshot = {
    epoch: context.epoch,
    input: (read) => readJournalSqlInput(scope, read),
    itemBody: (itemId) => (context.visible(itemId) ? context.item(itemId)?.body : null),
    rootStatusSignedOutAt: (fence) => {
      for (const row of scope.db.prepare(ROOT_STATUSES_AT_FENCE).iterate(...scope.prefix, fence)) {
        scope.examined(row)
        const item = context.item(String(JSON.parse(String(row.entry_key))))
        if (item && journalStatusReportsSignedOut(item.body, item)) {
          return true
        }
      }
      return false
    }
  }
  return operation.kind === 'restart-progress'
    ? {
        kind: 'restart-progress',
        progress: readJournalRestartProgress(snapshot, operation.cursor)
      }
    : { kind: 'outgrown-child', child: readJournalOutgrownChild(snapshot, operation.input) }
}
