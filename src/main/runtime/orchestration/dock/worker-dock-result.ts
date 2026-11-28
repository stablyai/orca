// What a finished worker left for its chat: its report or end reason, read for the dock's result view.
import { z } from 'zod'
import type { OrchestrationDb } from '../db/orchestration-db'
import { WorkerDockResult } from '../../../../shared/orchestration/dock/worker-dock'
import { OrchestrationError } from '../orchestration-error'
import { workerDockSession } from './worker-dock-source'
import { epoch, launchOptions } from './worker-dock-row-values'

/** Each worker's end reason as the strip shows it, for readers outside the strip. */
export function readWorkerDockReasons(
  db: OrchestrationDb,
  dispatchIds: readonly string[]
): Map<string, string> {
  const rows = dispatchIds.length
    ? db.db
        .prepare(`SELECT f.dispatch_id, f.reason FROM json_each(?) selected
      CROSS JOIN worker_dock_facts f ON f.dispatch_id = selected.value WHERE f.reason IS NOT NULL`)
        .all(JSON.stringify(dispatchIds))
    : []
  return new Map(rows.map((row) => [String(row.dispatch_id), String(row.reason)]))
}

export function readWorkerDockResult(
  db: OrchestrationDb,
  party: string,
  dispatchId: string
): WorkerDockResult | null {
  const row = db.db
    .prepare(`SELECT f.dispatch_id, f.report_id, f.settlement, f.changed_at, f.state, w.last_error, d.last_failure,
    NOT EXISTS(SELECT 1 FROM federated_dispatches remote WHERE remote.dispatch_id = f.dispatch_id) AS owner_actions_available,
    COALESCE(t.task_title, t.spec) AS title, t.display_name,
    COALESCE(w.worktree_id, (SELECT r.worktree_id FROM worker_terminal_resources r WHERE r.owner_dispatch_id = f.dispatch_id LIMIT 1)) AS workspace_id, w.start_options, m.body, m.payload, accepted.payload AS accepted_payload,
    EXISTS(SELECT 1 FROM worker_dock_acknowledgments a WHERE a.source = f.source
      AND a.dispatch_id = f.dispatch_id AND a.settlement = f.settlement) AS acknowledged
    FROM worker_dock_facts f JOIN dispatch_contexts d ON d.id = f.dispatch_id
    JOIN tasks t ON t.id = d.task_id JOIN worker_dispatches w ON w.dispatch_id = f.dispatch_id
    LEFT JOIN messages m ON m.id = f.report_id
    LEFT JOIN attempt_observation_facts accepted ON accepted.id = 'worker_report:' || f.report_id
    WHERE f.source = ? AND f.dispatch_id = ?`)
    .get(workerDockSession(party), dispatchId)
  if (!row) {
    throw new OrchestrationError(
      'dispatch_not_found',
      'This worker is not part of this source session.'
    )
  }
  const failureReason =
    typeof row.last_error === 'string'
      ? row.last_error
      : typeof row.last_failure === 'string'
        ? row.last_failure
        : null
  // Only a requested stop reaches 'stopped'; a crash or lost terminal settles failed or abandoned.
  const stopped = row.state === 'stopped'
  const failure = row.state === 'failed' || row.state === 'abandoned'
  if (typeof row.body !== 'string' && !stopped && !(failure && failureReason)) {
    return null
  }
  const outcome =
    reportOutcome(row.accepted_payload) ??
    reportOutcome(row.payload) ??
    (stopped ? 'stopped' : failure ? (row.state === 'failed' ? 'failed' : 'unexpected') : null)
  if (!outcome) {
    return null
  }
  return WorkerDockResult.parse({
    id: row.report_id ?? `settlement:${String(row.settlement)}`,
    dispatchId,
    name:
      row.display_name ??
      launchOptions(row.start_options).name ??
      launchOptions(row.start_options).agent ??
      'Worker',
    title: row.title,
    outcome,
    body: row.body ?? (stopped ? '' : failureReason),
    report: typeof row.body === 'string',
    at: epoch(row.changed_at),
    settlement: row.settlement ?? `worker_report:${String(row.report_id)}`,
    acknowledged: row.acknowledged === 1,
    ownerActionsAvailable: row.owner_actions_available === 1,
    ...(typeof row.workspace_id === 'string' ? { workspaceId: row.workspace_id } : {})
  })
}
function reportOutcome(payload: unknown): 'succeeded' | 'failed' | null {
  try {
    const parsed = z
      .object({ outcome: z.enum(['succeeded', 'failed']) })
      .safeParse(JSON.parse(String(payload)))
    return parsed.success ? parsed.data.outcome : null
  } catch {
    return null
  }
}
