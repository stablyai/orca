export { workerDockSession } from './worker-dock-source'
import { workerDockSession } from './worker-dock-source'
export { acknowledgeWorkerDock } from './worker-dock-acknowledgment'
import { readWorkerDockSnapshot } from './worker-dock-read-snapshot'
import { workerLaunchModel } from '../workers/launch/worker-launch-observation'
import { z } from 'zod'
import type { OrchestrationDb } from '../db/orchestration-db'
import {
  type WorkerDockRead,
  WorkerDockEntry,
  WorkerDockResultRef,
  WorkerDockResult,
  compareWorkerDockResultRefs,
  compareWorkerDockEntries,
  type WorkerDockSnapshot
} from '../../../../shared/orchestration/dock/worker-dock'
import { exposeUtcTimestamp } from '../db/utc-timestamp'
import { OrchestrationError } from '../orchestration-error'
import {
  readProviderFailureIdentities,
  readProviderFailureRows
} from './worker-dock-provider-failures'
import { workerDockEligibleSql as eligible } from '../db/worker-dock-eligibility'
import { readWorkerDockActivity, workerDockActivityRevision } from './worker-dock-activity'

const stateSql = `CASE f.state
  WHEN 'ready' THEN 'unavailable' WHEN 'succeeded' THEN CASE WHEN f.result_lost_at IS NOT NULL THEN 'unavailable' ELSE 'saving' END
  WHEN 'stopped' THEN 'unexpected' WHEN 'abandoned' THEN 'unexpected'
  WHEN 'start_unknown' THEN 'unavailable' WHEN 'stop_unknown' THEN 'unavailable'
  ELSE f.state END`
const identitySql = `json_array(f.home, f.source, 'worker', f.dispatch_id)`
const Metadata = z.object({
  id: z.string(),
  dispatchId: z.string(),
  state: WorkerDockEntry.shape.state,
  changedAt: z.number().nullable(),
  ownerActionsAvailable: z.coerce.boolean(),
  hasModel: z.coerce.boolean(),
  settlement: z.string().nullable()
})

function epoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value !== 'string') {
    return null
  }
  const ms = Date.parse(exposeUtcTimestamp(value) ?? '')
  return Number.isFinite(ms) ? ms : null
}
const Launch = z.object({
  name: z.string().optional(),
  launch: z.unknown().optional(),
  agent: z.string().optional()
})
function launchOptions(value: unknown): z.infer<typeof Launch> {
  try {
    return Launch.parse(JSON.parse(typeof value === 'string' ? value : '{}'))
  } catch {
    return {}
  }
}

export function readWorkerDock(
  db: OrchestrationDb,
  request: z.infer<typeof WorkerDockRead>
): WorkerDockSnapshot {
  return readWorkerDockSnapshot(db.db, () => {
    const source = workerDockSession(request.party)
    // Both counters only rise, so their sum moves whenever either does.
    const revision =
      z
        .object({ revision: z.number() })
        .parse(db.db.prepare('SELECT revision FROM worker_dock_revision WHERE id = 1').get())
        .revision + workerDockActivityRevision(db)
    const activity = readWorkerDockActivity(db, source)
    const identities: WorkerDockSnapshot['identities'] = db.db
      .prepare(`SELECT ${identitySql} AS id, f.dispatch_id AS dispatchId,
      ${stateSql} AS state, f.changed_at AS changedAt, f.settlement, (f.model IS NOT NULL AND length(trim(f.model)) > 0) AS hasModel,
      NOT EXISTS(SELECT 1 FROM federated_dispatches remote WHERE remote.dispatch_id = f.dispatch_id) AS ownerActionsAvailable,
      f.state = 'ready' AS ready FROM worker_dock_facts f INDEXED BY worker_dock_eligible
      WHERE ${eligible}
      ORDER BY CASE WHEN f.state IN ('failed', 'stopped', 'abandoned') THEN 0 ELSE 1 END,
        changedAt IS NULL, changedAt DESC, ${identitySql} COLLATE BINARY`)
      .all(source)
      .map((row) => {
        const identity = Metadata.parse(row)
        // A ready worker shows the activity its agent status gives it, kept in memory.
        const live = row.ready === 1 ? activity?.get(identity.dispatchId) : undefined
        return live ? { ...identity, state: live.state, changedAt: live.changedAt } : identity
      })
    const providerFailures = readProviderFailureIdentities(db, source)
    if (providerFailures?.length) {
      identities.push(...providerFailures)
    }
    if (providerFailures?.length || activity?.size) {
      identities.sort(compareWorkerDockEntries)
    }
    const found = request.anchor ? identities.findIndex((row) => row.id === request.anchor) : 0
    const center = Math.max(0, found)
    const start =
      request.direction === 'after'
        ? center
        : Math.max(0, center - (request.direction === 'before' ? 49 : 10))
    const selected = request.includeRows === false ? [] : identities.slice(start, start + 50)
    const workers = providerFailures?.length
      ? selected.filter((row) => !row.kind || row.kind === 'worker')
      : selected
    const details = new Map(
      workers.length
        ? db.db
            .prepare(`SELECT f.dispatch_id, f.source, f.changed_at, f.report_id, f.reason,
      w.start_options, w.created_at, w.last_error, w.state,
      EXISTS(SELECT 1 FROM federated_dispatches remote WHERE remote.dispatch_id = f.dispatch_id) AS remote, d.last_failure, COALESCE(t.task_title, t.spec) AS title, t.display_name
      FROM json_each(?) selected CROSS JOIN worker_dock_facts f ON f.dispatch_id = selected.value
      CROSS JOIN worker_dispatches w ON w.dispatch_id = f.dispatch_id
      CROSS JOIN dispatch_contexts d ON d.id = f.dispatch_id CROSS JOIN tasks t ON t.id = d.task_id`)
            .all(JSON.stringify(workers.map((row) => row.dispatchId)))
            .map((row) => [row.dispatch_id, row])
        : []
    )
    const rows = workers.map((identity) => {
      const row = details.get(identity.dispatchId)
      if (!row) {
        throw new Error('Worker dock snapshot changed inside its read transaction.')
      }
      const launch = launchOptions(row.start_options)
      return WorkerDockEntry.parse({
        ...identity,
        source,
        name: row.display_name ?? launch.name ?? launch.agent ?? 'Worker',
        title: row.title,
        model: workerLaunchModel(launch.launch),
        changedAt: identity.changedAt,
        startedAt: epoch(row.created_at),
        reason: row.reason ?? null,
        resultId: row.report_id ?? null,
        stoppable: row.state === 'ready' || row.state === 'start_unknown',
        ownerActionsAvailable: row.remote !== 1
      })
    })
    if (workers.length < selected.length) {
      rows.push(
        ...readProviderFailureRows(
          db,
          selected.filter((row) => row.kind && row.kind !== 'worker').map((row) => row.id)
        )
      )
    }
    const snapshot = {
      revision,
      results: readWorkerDockResultRefs(db, request.party),
      expired: request.revision !== undefined && request.revision !== revision,
      identities,
      rows,
      anchor: identities[center]?.id ?? null
    }
    db.workerDockSources.rememberSnapshot(source, snapshot, Boolean(providerFailures?.length))
    return snapshot
  })
}

export function readWorkerDockResult(
  db: OrchestrationDb,
  party: string,
  dispatchId: string
): WorkerDockResult | null {
  const row = db.db
    .prepare(`SELECT f.dispatch_id, f.report_id, f.settlement, f.changed_at, f.state, w.last_error, d.last_failure,
    NOT EXISTS(SELECT 1 FROM federated_dispatches remote WHERE remote.dispatch_id = f.dispatch_id) AS owner_actions_available,
    COALESCE(t.task_title, t.spec) AS title, t.display_name, w.start_options, m.body, m.payload, accepted.payload AS accepted_payload, s.receipt,
    EXISTS(SELECT 1 FROM worker_dock_acknowledgments a WHERE a.source = f.source
      AND a.dispatch_id = f.dispatch_id AND a.settlement = f.settlement) AS acknowledged
    FROM worker_dock_facts f JOIN dispatch_contexts d ON d.id = f.dispatch_id
    JOIN tasks t ON t.id = d.task_id JOIN worker_dispatches w ON w.dispatch_id = f.dispatch_id
    LEFT JOIN messages m ON m.id = f.report_id
    LEFT JOIN attempt_observation_facts accepted ON accepted.id = 'worker_report:' || f.report_id
    LEFT JOIN worker_dock_owner_stops s ON s.dispatch_id = f.dispatch_id AND s.confirmed = 1 AND s.settlement = f.settlement
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
  const failure = row.state === 'failed' || row.state === 'stopped' || row.state === 'abandoned'
  if (typeof row.body !== 'string' && !row.receipt && !(failure && failureReason)) {
    return null
  }
  const outcome = row.receipt
    ? 'stopped'
    : (reportOutcome(row.accepted_payload) ??
      reportOutcome(row.payload) ??
      (failure ? (row.state === 'failed' ? 'failed' : 'unexpected') : null))
  if (!outcome) {
    return null
  }
  return WorkerDockResult.parse({
    id:
      row.report_id ??
      (row.receipt ? `owner_stop:${dispatchId}` : `settlement:${String(row.settlement)}`),
    dispatchId,
    name:
      row.display_name ??
      launchOptions(row.start_options).name ??
      launchOptions(row.start_options).agent ??
      'Worker',
    title: row.title,
    outcome,
    body: row.body ?? (row.receipt ? 'Stopped by you.' : failureReason),
    at: epoch(row.changed_at),
    settlement: row.settlement ?? `worker_report:${String(row.report_id)}`,
    acknowledged: row.acknowledged === 1,
    ownerActionsAvailable: row.owner_actions_available === 1
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

export function readWorkerDockResultRefs(
  db: OrchestrationDb,
  party: string,
  before?: WorkerDockResultRef
): WorkerDockResultRef[] {
  const source = workerDockSession(party)
  const boundary = before
    ? `AND (f.changed_at < ? OR (f.changed_at = ? AND f.dispatch_id > ?) OR (f.changed_at IS NULL AND (? IS NOT NULL OR f.dispatch_id > ?)))`
    : ''
  const bindings = [
    source,
    ...(before ? [before.at, before.at, before.dispatchId, before.at, before.dispatchId] : [])
  ]
  const reports = db.db
    .prepare(`SELECT f.dispatch_id AS dispatchId, f.report_id AS id, f.changed_at AS at,
    COALESCE(f.settlement, 'worker_report:' || f.report_id) AS settlement,
    COALESCE(t.display_name, json_extract(w.start_options, '$.name'), json_extract(w.start_options, '$.agent'), 'Worker') AS name,
    COALESCE(t.task_title, substr(t.spec, 1, 256)) AS title, substr(m.body, 1, 256) AS summary, COALESCE(json_extract(accepted.payload, '$.outcome'), json_extract(m.payload, '$.outcome')) AS outcome
    FROM (SELECT dispatch_id, report_id, changed_at, settlement FROM worker_dock_facts f INDEXED BY worker_dock_result_time
      WHERE f.source = ? AND f.report_id IS NOT NULL ${boundary}
      ORDER BY f.changed_at DESC, f.dispatch_id LIMIT 50) f JOIN messages m ON m.id = f.report_id
    LEFT JOIN attempt_observation_facts accepted ON accepted.id = 'worker_report:' || f.report_id
    JOIN worker_dispatches w ON w.dispatch_id = f.dispatch_id
    JOIN dispatch_contexts d ON d.id = f.dispatch_id JOIN tasks t ON t.id = d.task_id
    ORDER BY f.changed_at DESC, f.dispatch_id LIMIT 50`)
    .all(...bindings)
  const stops = db.db
    .prepare(`SELECT f.dispatch_id AS dispatchId, f.id, f.changed_at AS at, f.settlement,
    COALESCE(t.display_name, json_extract(w.start_options, '$.name'), json_extract(w.start_options, '$.agent'), 'Worker') AS name,
    COALESCE(t.task_title, substr(t.spec, 1, 256)) AS title, 'Stopped by you.' AS summary, 'stopped' AS outcome
    FROM (SELECT dispatch_id, id, changed_at, settlement FROM worker_dock_stop_results f INDEXED BY worker_dock_stop_result_time
      WHERE f.source = ? ${boundary} ORDER BY f.changed_at DESC, f.dispatch_id LIMIT 50) f
    JOIN worker_dispatches w ON w.dispatch_id = f.dispatch_id
    JOIN dispatch_contexts d ON d.id = f.dispatch_id JOIN tasks t ON t.id = d.task_id
    ORDER BY f.changed_at DESC, f.dispatch_id LIMIT 50`)
    .all(...bindings)
  const failures = db.db
    .prepare(`SELECT f.dispatch_id AS dispatchId, f.id, f.changed_at AS at, f.settlement,
    COALESCE(t.display_name, json_extract(w.start_options, '$.name'), json_extract(w.start_options, '$.agent'), 'Worker') AS name,
    COALESCE(t.task_title, substr(t.spec, 1, 256)) AS title, COALESCE(w.last_error, d.last_failure, '') AS summary,
    CASE WHEN w.state = 'failed' THEN 'failed' ELSE 'unexpected' END AS outcome
    FROM (SELECT dispatch_id, id, changed_at, settlement FROM worker_dock_failure_results f INDEXED BY worker_dock_failure_result_time
      WHERE f.source = ? ${boundary} ORDER BY f.changed_at DESC, f.dispatch_id LIMIT 50) f
    JOIN worker_dispatches w ON w.dispatch_id = f.dispatch_id
    JOIN dispatch_contexts d ON d.id = f.dispatch_id JOIN tasks t ON t.id = d.task_id
    ORDER BY f.changed_at DESC, f.dispatch_id LIMIT 50`)
    .all(...bindings)
  return [...reports, ...stops, ...failures]
    .map((row) => WorkerDockResultRef.parse(row))
    .sort(compareWorkerDockResultRefs)
    .slice(0, 50)
}
