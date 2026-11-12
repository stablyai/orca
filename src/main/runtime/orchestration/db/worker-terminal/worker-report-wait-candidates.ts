import { fleetWorkerIdentity } from '../../../../../shared/orchestration/fleet/orchestration-fleet-agent-status-evidence'
import { ORCHESTRATION_FLEET_PAGE_MAX } from '../../../../../shared/orchestration/fleet/orchestration-fleet-projection'
import { SETTLED_WORKER_STATES } from '../../../../../shared/orchestration/fleet/orchestration-fleet-worker-projection'
import type { OrchestrationDb } from '../orchestration-db'
import { WORKER_TERMINAL_HANDED_ON_SQL } from './worker-terminal-inventory-counts'

const SETTLED_WORKER_STATE_LIST = [...SETTLED_WORKER_STATES].map((state) => `'${state}'`).join(', ')

type CandidateRow = {
  dispatch_id: string
  database_id: number
  agent_terminal_handle: string | null
  pane_key: string | null
  may_run: number
  may_owe_action: number
}

/** worker-list's identity columns for the `seed` rows in Run `runParam`, plus whether each can still be running or owe an action.
 *  CROSS JOIN keeps SQLite driving from the seeds; it would otherwise walk the whole Run by run_id. */
function candidateSelect(runParam: string): string {
  return `SELECT d.id AS dispatch_id, d.rowid AS database_id,
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
              AND r.release_state IS NOT 'retained')) AS may_owe_action
    FROM seed
    CROSS JOIN dispatch_contexts d ON d.id = seed.id AND d.run_id = ${runParam}
    LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
    LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id`
}

/**
 * Every row that can set may_run or may_owe_action, each read from an index so settled history is
 * never visited: an unsettled Dispatch status (the only way an unsupervised row without a terminal
 * owes anything), an unsettled worker, an unreleased terminal, or a liveness fact.
 */
const SEED_SQL = `WITH seed(id) AS (
    SELECT id FROM dispatch_contexts
     WHERE run_id = ?1 AND status IN ('pending', 'dispatched', 'failed', 'circuit_broken')
    UNION SELECT dispatch_id FROM worker_dispatches
     WHERE state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
    UNION SELECT owner_dispatch_id FROM worker_terminal_resources
     WHERE release_state IN ('not_requested', 'requested', 'releasing', 'unknown', 'retained')
    UNION SELECT dispatch_id FROM attempt_observation_facts WHERE facet = 'liveness')
  ${candidateSelect('?1')}`

/** Every row of the Run that may own one of these handles or panes. */
const OWNER_SQL = `WITH seed(id) AS (
    SELECT dispatch_id FROM worker_dispatches
     WHERE agent_terminal_handle IN (SELECT value FROM json_each(?1))
    UNION SELECT id FROM dispatch_contexts WHERE assignee_handle IN (SELECT value FROM json_each(?1))
    UNION SELECT owner_dispatch_id FROM worker_terminal_resources
     WHERE pane_key IN (SELECT value FROM json_each(?2))
    UNION SELECT id FROM dispatch_contexts WHERE assignee_pane_key IN (SELECT value FROM json_each(?2)))
  ${candidateSelect('?3')}`

/** Newest-first position in the Run, as worker-list pages it; the status list is the column's CHECK, so each status seeks its rowid range. */
const RUN_POSITION_SQL = `SELECT requested.value AS database_id,
    (SELECT COUNT(*) FROM dispatch_contexts
      WHERE run_id = ?2 AND status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')
        AND rowid > requested.value) AS position
  FROM json_each(?1) AS requested`

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

const isCandidate = (row: CandidateRow) => row.may_run === 1 || row.may_owe_action === 1

/**
 * The Run's Dispatches whose worker-list outcome can be in_progress or whose next action can be
 * other than none, grouped by the newest-first page worker-list projects them in. Each group adds
 * one other owner of every handle or pane its candidates use, since a page that shares an identity
 * withholds status evidence. Everything else is settled history that projects to none.
 */
export function listWorkerReportWaitCandidates(this: OrchestrationDb, runId: string): string[][] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects exactly these columns.
  const seeded = this.db.prepare(SEED_SQL).all(runId) as CandidateRow[]
  // Without a possibly running worker the hint cannot apply, so nothing needs projecting.
  if (!seeded.some((row) => row.may_run === 1)) {
    return []
  }
  const candidates = seeded.filter(isCandidate)
  const keys = new Set(candidates.flatMap(ownerKeys))
  const keyValues = (prefix: string) =>
    JSON.stringify(
      [...keys].flatMap((key) => (key.startsWith(prefix) ? [key.slice(prefix.length)] : []))
    )
  const candidateIds = new Set(candidates.map((row) => row.dispatch_id))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects exactly these columns.
  const owners = this.db
    .prepare(OWNER_SQL)
    .all(keyValues('handle:'), keyValues('pane:'), runId) as CandidateRow[]
  const others = owners.filter(
    (row) => !candidateIds.has(row.dispatch_id) && ownerKeys(row).some((key) => keys.has(key))
  )
  const owned = [...candidates, ...others].flatMap(ownerKeys)
  if (new Set(owned).size === owned.length) {
    // No identity has two owners in the Run, so no page withholds evidence and pages do not matter.
    return [candidates.map((row) => row.dispatch_id)]
  }
  return groupByWorkerListPage(this, runId, [...candidates, ...others])
}

function groupByWorkerListPage(
  db: OrchestrationDb,
  runId: string,
  rows: CandidateRow[]
): string[][] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects exactly these columns.
  const positions = db.db
    .prepare(RUN_POSITION_SQL)
    .all(JSON.stringify(rows.map((row) => row.database_id)), runId) as {
    database_id: number
    position: number
  }[]
  const pageOf = new Map(
    positions.map((row) => [
      row.database_id,
      Math.floor(row.position / ORCHESTRATION_FLEET_PAGE_MAX)
    ])
  )
  const pages = new Map<number, CandidateRow[]>()
  for (const row of rows) {
    const page = pageOf.get(row.database_id) ?? 0
    pages.set(page, [...(pages.get(page) ?? []), row])
  }
  return [...pages.values()].flatMap((page) => {
    const kept = page.filter(isCandidate)
    // One more owner already makes a key shared; further owners change nothing.
    const unshared = new Set(kept.flatMap(ownerKeys))
    for (const row of page) {
      const claimed = isCandidate(row) ? [] : ownerKeys(row).filter((key) => unshared.has(key))
      if (claimed.length > 0) {
        claimed.forEach((key) => unshared.delete(key))
        kept.push(row)
      }
    }
    return kept.length > 0 ? [kept.map((row) => row.dispatch_id)] : []
  })
}
