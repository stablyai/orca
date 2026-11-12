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

/** worker-list's identity columns, plus whether the row can still be running or owe an action. */
const CANDIDATE_COLUMNS = `d.id AS dispatch_id, d.rowid AS database_id,
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
         AND r.release_state IS NOT 'retained')) AS may_owe_action`

const CANDIDATE_JOINS = `LEFT JOIN worker_dispatches w ON w.dispatch_id = d.id
    LEFT JOIN worker_terminal_resources r ON r.owner_dispatch_id = d.id`

/**
 * Every row that can set may_run or may_owe_action, each read from an index so settled history is
 * never visited: an unsettled Dispatch status (the only way an unsupervised row without a terminal
 * owes anything), an unsettled worker, a terminal still owed a release, an unreleased terminal whose
 * Dispatch has no worker, or a liveness fact. CROSS JOIN keeps SQLite driving from these seeds
 * instead of walking the Run by run_id.
 */
const SEED_SQL = `WITH seed(id) AS (
    SELECT id FROM dispatch_contexts
     WHERE run_id = ?1 AND status IN ('pending', 'dispatched', 'failed', 'circuit_broken')
    UNION SELECT dispatch_id FROM worker_dispatches
     WHERE state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
    UNION SELECT owner_dispatch_id FROM worker_terminal_resources
     WHERE release_state IN ('not_requested', 'requested', 'releasing', 'unknown')
       AND ownership_state = 'owned'
    UNION SELECT r.owner_dispatch_id FROM worker_terminal_resources r
     WHERE r.release_state IN ('not_requested', 'requested', 'releasing', 'unknown', 'retained')
       AND NOT EXISTS (SELECT 1 FROM worker_dispatches w WHERE w.dispatch_id = r.owner_dispatch_id)
    UNION SELECT dispatch_id FROM attempt_observation_facts WHERE facet = 'liveness')
  SELECT ${CANDIDATE_COLUMNS}
    FROM seed CROSS JOIN dispatch_contexts d ON d.id = seed.id AND d.run_id = ?1
    ${CANDIDATE_JOINS}`

/** Newest-first position in the Run, which is how worker-list pages it. */
const RUN_POSITION_SQL = `SELECT COUNT(*) AS position FROM dispatch_contexts
  WHERE run_id = ? AND rowid > ?`

/** The row `offset` rows from `rowid` in the Run, newer or older. */
const NEWER_ROW_SQL = `SELECT rowid AS database_id FROM dispatch_contexts
  WHERE run_id = ? AND rowid >= ? ORDER BY rowid ASC LIMIT 1 OFFSET ?`
const OLDER_ROW_SQL = `SELECT rowid AS database_id FROM dispatch_contexts
  WHERE run_id = ? AND rowid <= ? ORDER BY rowid DESC LIMIT 1 OFFSET ?`

/** Rows on one page (rowids ?4..?5 of Run ?3) that may own one of these handles (?1) or panes (?2). */
const PAGE_OWNER_SQL = `WITH seed(id) AS (
    SELECT id FROM dispatch_contexts
     WHERE assignee_handle IN (SELECT value FROM json_each(?1)) AND rowid BETWEEN ?4 AND ?5
    UNION SELECT dispatch_id FROM worker_dispatches
     WHERE agent_terminal_handle IN (SELECT value FROM json_each(?1))
    UNION SELECT owner_dispatch_id FROM worker_terminal_resources
     WHERE pane_key IN (SELECT value FROM json_each(?2))
    UNION SELECT id FROM dispatch_contexts
     WHERE assignee_pane_key IN (SELECT value FROM json_each(?2)) AND rowid BETWEEN ?4 AND ?5)
  SELECT ${CANDIDATE_COLUMNS}
    FROM seed CROSS JOIN dispatch_contexts d
      ON d.id = seed.id AND d.run_id = ?3 AND d.rowid BETWEEN ?4 AND ?5
    ${CANDIDATE_JOINS}`

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
 * withholds status evidence. Only pages holding a candidate are read, so settled history is not.
 */
export function listWorkerReportWaitCandidates(this: OrchestrationDb, runId: string): string[][] {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects exactly these columns.
  const seeded = this.db.prepare(SEED_SQL).all(runId) as CandidateRow[]
  // Without a possibly running worker the hint cannot apply, so nothing needs projecting.
  if (!seeded.some((row) => row.may_run === 1)) {
    return []
  }
  const pages = new Map<number, { anchor: CandidateRow; position: number; rows: CandidateRow[] }>()
  for (const row of seeded.filter(isCandidate)) {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: COUNT(*) selects one number.
    const { position } = this.db.prepare(RUN_POSITION_SQL).get(runId, row.database_id) as {
      position: number
    }
    const page = Math.floor(position / ORCHESTRATION_FLEET_PAGE_MAX)
    const entry = pages.get(page) ?? { anchor: row, position, rows: [] }
    entry.rows.push(row)
    pages.set(page, entry)
  }
  return [...pages.entries()].map(([page, { anchor, position, rows }]) => {
    const keys = new Set(rows.flatMap(ownerKeys))
    if (keys.size === 0) {
      return rows.map((row) => row.dispatch_id)
    }
    const rowAt = (sql: string, from: number, offset: number) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects one rowid.
      (this.db.prepare(sql).get(runId, from, offset) as { database_id: number } | undefined)
        ?.database_id
    const top = rowAt(
      NEWER_ROW_SQL,
      anchor.database_id,
      position - page * ORCHESTRATION_FLEET_PAGE_MAX
    )
    const bottom =
      top === undefined ? undefined : rowAt(OLDER_ROW_SQL, top, ORCHESTRATION_FLEET_PAGE_MAX - 1)
    const values = (prefix: string) =>
      JSON.stringify(
        [...keys].flatMap((key) => (key.startsWith(prefix) ? [key.slice(prefix.length)] : []))
      )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the query selects exactly these columns.
    const owners = this.db
      .prepare(PAGE_OWNER_SQL)
      .all(
        values('handle:'),
        values('pane:'),
        runId,
        bottom ?? 0,
        top ?? anchor.database_id
      ) as CandidateRow[]
    const candidateIds = new Set(rows.map((row) => row.dispatch_id))
    return keptRowsOfPage([...rows, ...owners.filter((row) => !candidateIds.has(row.dispatch_id))])
  })
}

function keptRowsOfPage(page: CandidateRow[]): string[] {
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
  return kept.map((row) => row.dispatch_id)
}
