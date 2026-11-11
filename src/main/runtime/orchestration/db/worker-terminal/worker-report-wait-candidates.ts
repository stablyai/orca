import { fleetWorkerIdentity } from '../../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import { SETTLED_WORKER_STATES } from '../../../../../shared/orchestration/fleet/orchestration-fleet-worker-projection'
import type { OrchestrationDb } from '../orchestration-db'
import { WORKER_TERMINAL_HANDED_ON_SQL } from './worker-terminal-inventory-counts'

const SETTLED_WORKER_STATE_LIST = [...SETTLED_WORKER_STATES].map((state) => `'${state}'`).join(', ')

type CandidateRow = {
  dispatch_id: string
  agent_terminal_handle: string | null
  pane_key: string | null
  may_run: number
  may_owe_action: number
}

/** The keys worker-list's status index counts owners by, from the same identity. */
function ownerKeys(row: CandidateRow): string[] {
  const identity = fleetWorkerIdentity({
    agentTerminalHandle: row.agent_terminal_handle,
    paneKey: row.pane_key
  })
  if (identity.kind === 'unidentifiable') {
    return []
  }
  const handleKey = `handle:${identity.terminalHandle}`
  return identity.kind === 'pane_and_terminal'
    ? [handleKey, `pane:${identity.paneKey}`]
    : [handleKey]
}

/**
 * The Run's Dispatches whose worker-list outcome can be in_progress or whose next action can be
 * other than none, plus one other owner of each handle or pane they use, since a shared identity
 * withholds status evidence. Everything else is settled history that projects to none.
 */
export function listWorkerReportWaitCandidates(this: OrchestrationDb, runId: string): string[] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects exactly these columns.
  const rows = this.db
    .prepare(
      `SELECT d.id AS dispatch_id,
              CASE WHEN ${WORKER_TERMINAL_HANDED_ON_SQL} THEN NULL
                ELSE COALESCE(w.agent_terminal_handle, d.assignee_handle) END AS agent_terminal_handle,
              CASE WHEN ${WORKER_TERMINAL_HANDED_ON_SQL} THEN NULL
                ELSE COALESCE(r.pane_key, d.assignee_pane_key) END AS pane_key,
              (d.status IN ('pending', 'dispatched')
                OR EXISTS (SELECT 1 FROM attempt_observation_facts f
                            WHERE f.dispatch_id = d.id AND f.facet = 'liveness')) AS may_run,
              ((COALESCE(w.state, 'unsupervised') NOT IN (${SETTLED_WORKER_STATE_LIST})
                 AND w.stage IS NOT 'released' AND r.release_state IS NOT 'released'
                 AND NOT (d.status = 'completed' AND w.dispatch_id IS NULL AND r.id IS NULL))
               OR (r.ownership_state = 'owned' AND r.release_state IS NOT 'released'
                   AND r.release_state IS NOT 'retained')
              ) AS may_owe_action
         FROM dispatch_contexts d
         LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
         LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id
        WHERE d.run_id = ?`
    )
    .all(runId) as CandidateRow[]
  // Without a possibly running worker the hint cannot apply, so nothing needs projecting.
  if (!rows.some((row) => row.may_run === 1)) {
    return []
  }
  const isCandidate = (row: CandidateRow) => row.may_run === 1 || row.may_owe_action === 1
  const kept = rows.filter(isCandidate)
  // One more owner already makes a key shared; further owners change nothing.
  const unshared = new Set(kept.flatMap(ownerKeys))
  for (const row of rows) {
    const claimed = isCandidate(row) ? [] : ownerKeys(row).filter((key) => unshared.has(key))
    if (claimed.length > 0) {
      claimed.forEach((key) => unshared.delete(key))
      kept.push(row)
    }
  }
  return [...new Set(kept.map((row) => row.dispatch_id))]
}
