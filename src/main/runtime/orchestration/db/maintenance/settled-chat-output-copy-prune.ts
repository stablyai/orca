import type Database from '../../../../sqlite/sync-database'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { releaseCommitFieldsForCapturedArchive } from '../../workers/archives/worker-output-archive'

// Pages are small so each write holds the lock for about a millisecond.
const PAGE_ROWS = 4
// References stay well under 2 KB; saved copies were up to 256 KB.
const SAVED_COPY_SQL = "a.kind = 'structured_journal' AND octet_length(a.content) > 2048"

/**
 * One page of chat workers' saved output copies whose Run settled over a day ago, rewritten to
 * the reference later releases store: released reads then open the chat itself, which holds the
 * same history. Copies of terminal workers stay; they have nothing else to point at.
 */
export function pruneSettledChatOutputCopies(
  db: Database.Database,
  after: string
): { pruned: number; next: string | null } {
  db.exec('BEGIN IMMEDIATE')
  try {
    const rows = db
      .prepare(
        `SELECT a.dispatch_id,
           CASE WHEN json_valid(a.content) THEN json_extract(a.content, '$.agent') END AS agent,
           CASE WHEN json_valid(a.content) THEN json_extract(a.content, '$.processIncarnation') END
             AS process_incarnation
         FROM worker_terminal_archives a
         JOIN worker_terminal_resources r ON r.id = a.resource_id
         JOIN dispatch_contexts d ON d.id = a.dispatch_id
         WHERE a.dispatch_id > ? AND ${SAVED_COPY_SQL}
           AND r.release_state = 'released'
           AND julianday(r.release_completed_at) < julianday('now', '-1 day')
           AND NOT EXISTS (
             SELECT 1 FROM dispatch_contexts run_dispatch
             WHERE run_dispatch.run_id = d.run_id
               AND (run_dispatch.status IN ('pending', 'dispatched')
                 OR julianday(run_dispatch.completed_at) >= julianday('now', '-1 day')))
         ORDER BY a.dispatch_id
         LIMIT ?`
      )
      .all(after, PAGE_ROWS) as {
      dispatch_id: string
      agent: unknown
      process_incarnation: unknown
    }[]
    const rewrite = db.prepare(
      `UPDATE worker_terminal_archives AS a SET content = ? WHERE a.dispatch_id = ? AND ${SAVED_COPY_SQL}`
    )
    for (const row of rows) {
      const { content } = releaseCommitFieldsForCapturedArchive({
        kind: 'structured_journal',
        status: 'captured',
        content: {
          version: 3,
          ...(typeof row.agent === 'string' ? { agent: row.agent as AgentType } : {}),
          ...(typeof row.process_incarnation === 'string'
            ? { processIncarnation: row.process_incarnation }
            : {})
        }
      })
      rewrite.run(content, row.dispatch_id)
    }
    db.exec('COMMIT')
    return {
      pruned: rows.length,
      next: rows.length < PAGE_ROWS ? null : rows.at(-1)!.dispatch_id
    }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
