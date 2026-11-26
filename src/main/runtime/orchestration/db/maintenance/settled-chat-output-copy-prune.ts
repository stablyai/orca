import type { OrchestrationDb } from '../orchestration-db'
import type { AgentType } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { releaseCommitFieldsForCapturedArchive } from '../../workers/archives/worker-output-archive'

// Rows examined per page, eligible or not, so one page never scans the whole table.
const PAGE_ROWS = 32
// Each rewrite parses a copy of up to 256 KB.
const REWRITES_PER_PAGE = 4

/**
 * One page of chat workers' saved output copies whose Run settled over a day ago, rewritten to
 * the reference later releases store, so released reads open the chat itself. A copy whose chat
 * this host cannot read stays: it is the only output left. Terminal workers' copies stay too.
 */
export function pruneSettledChatOutputCopies(
  { db }: OrchestrationDb,
  after: string,
  chatIsReadable: (dispatchId: string) => boolean,
  // Shared across a pass's pages, so a large settled Run is checked once per pass.
  settledRuns = new Map<string, boolean>()
): { pruned: number; next: string | null } {
  db.exec('BEGIN IMMEDIATE')
  try {
    // octet_length() reads only the record header, never the saved copy.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection names exactly these three columns; the adapter exposes unknown.
    const rows = db
      .prepare(
        `SELECT a.dispatch_id, d.run_id,
           a.kind = 'structured_journal' AND octet_length(a.content) > 2048
             AND r.release_state = 'released'
             AND julianday(r.release_completed_at) < julianday('now', '-1 day') AS candidate
         FROM worker_terminal_archives a
         LEFT JOIN worker_terminal_resources r ON r.id = a.resource_id
         LEFT JOIN dispatch_contexts d ON d.id = a.dispatch_id
         WHERE a.dispatch_id > ?
         ORDER BY a.dispatch_id
         LIMIT ?`
      )
      .all(after, PAGE_ROWS) as { dispatch_id: string; run_id: string | null; candidate: number }[]
    const runIsBusy = db.prepare(
      `SELECT 1 FROM dispatch_contexts
       WHERE run_id = ? AND (status IN ('pending', 'dispatched')
         OR julianday(completed_at) >= julianday('now', '-1 day'))
       LIMIT 1`
    )
    const runSettled = (runId: string): boolean => {
      let settled = settledRuns.get(runId)
      if (settled === undefined) {
        settled = !runIsBusy.get(runId)
        settledRuns.set(runId, settled)
      }
      return settled
    }
    const locator = db.prepare(
      `SELECT CASE WHEN json_valid(content) THEN json_extract(content, '$.agent') END AS agent,
         CASE WHEN json_valid(content) THEN json_extract(content, '$.processIncarnation') END
           AS process_incarnation
       FROM worker_terminal_archives WHERE dispatch_id = ?`
    )
    const rewrite = db.prepare(
      "UPDATE worker_terminal_archives SET content = ? WHERE dispatch_id = ? AND kind = 'structured_journal'"
    )
    let pruned = 0
    let next: string | null = rows.length < PAGE_ROWS ? null : rows.at(-1)!.dispatch_id
    for (const row of rows) {
      if (
        !row.candidate ||
        row.run_id === null ||
        !runSettled(row.run_id) ||
        !chatIsReadable(row.dispatch_id)
      ) {
        continue
      }
      const copy = locator.get(row.dispatch_id)
      const { content } = releaseCommitFieldsForCapturedArchive({
        kind: 'structured_journal',
        status: 'captured',
        content: {
          version: 3,
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the copy's release wrote this field from an AgentType.
          ...(typeof copy?.agent === 'string' ? { agent: copy.agent as AgentType } : {}),
          ...(typeof copy?.process_incarnation === 'string'
            ? { processIncarnation: copy.process_incarnation }
            : {})
        }
      })
      rewrite.run(content, row.dispatch_id)
      pruned += 1
      if (pruned === REWRITES_PER_PAGE) {
        next = row.dispatch_id
        break
      }
    }
    db.exec('COMMIT')
    return { pruned, next }
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
