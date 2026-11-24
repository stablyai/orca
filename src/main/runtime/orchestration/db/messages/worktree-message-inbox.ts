import type { OrchestrationDb } from '../orchestration-db'
import type { MessageRow } from '../orchestration-records'
import { getMessagesByIds } from './messages-by-id'

export function getWorktreeInbox(
  this: OrchestrationDb,
  options: {
    worktreeId: string
    terminalHandles: readonly string[]
    terminal?: string
    limit?: number
    runId?: string
  }
): MessageRow[] {
  const { worktreeId, terminalHandles, terminal, limit = terminal ? 100 : 20, runId } = options
  const runFilter = runId === undefined ? '' : 'AND run_id = ?'
  const terminalFilter = terminal === undefined ? '' : 'AND to_handle = ?'
  const ids = this.db
    .prepare(
      `WITH dispatches AS (
           SELECT dispatch_id, agent_terminal_handle FROM worker_dispatches WHERE worktree_id = ?
         ), parties(address) AS (
           SELECT 'dispatch:' || dispatch_id FROM dispatches
           UNION SELECT agent_terminal_handle FROM dispatches WHERE agent_terminal_handle IS NOT NULL
           UNION SELECT terminal_handle FROM worker_terminal_resources WHERE worktree_id = ?
           UNION SELECT value FROM json_each(?)
         )
         SELECT id FROM messages
         WHERE (from_handle IN (SELECT address FROM parties) OR to_handle IN (SELECT address FROM parties))
           ${runFilter} ${terminalFilter}
         ORDER BY sequence DESC LIMIT ?`
    )
    .all(
      worktreeId,
      worktreeId,
      JSON.stringify(terminalHandles),
      ...(runId === undefined ? [] : [runId]),
      ...(terminal === undefined ? [] : [terminal]),
      limit
    )
    .flatMap(({ id }) => (typeof id === 'string' ? [id] : []))
  const messages = getMessagesByIds(this, ids)
  return ids.flatMap((id) => messages.get(id) ?? [])
}
