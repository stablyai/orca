export { workerDockSession } from './worker-dock-source'
import { workerDockSession } from './worker-dock-source'
export { acknowledgeWorkerDock } from './worker-dock-acknowledgment'
export { readWorkerDockReasons, readWorkerDockResult } from './worker-dock-result'
import { readWorkerDockSnapshot } from './worker-dock-read-snapshot'
import { epoch, launchOptions } from './worker-dock-row-values'
import {
  workerLaunchModel,
  workerStartOptionsAgentValue
} from '../workers/launch/worker-launch-observation'
import { z } from 'zod'
import { lazyZodSchema } from '../../../../shared/schema/lazy-zod-schema'
import type { OrchestrationDb } from '../db/orchestration-db'
import {
  type WorkerDockRead,
  WorkerDockEntry,
  compareWorkerDockEntries,
  WORKER_DOCK_FAILURE_MS,
  WORKER_DOCK_UNKNOWN_MS,
  WORKER_DOCK_UNVERIFIED_READY_MS,
  type WorkerDockSnapshot
} from '../../../../shared/orchestration/dock/worker-dock'
import {
  readProviderFailureIdentities,
  readProviderFailureRows
} from './worker-dock-provider-failures'
import { workerDockCurrentRowsSql, workerDockEligibleSql } from '../db/worker-dock-eligibility'
import { readWorkerDockActivity, workerDockActivityRevision } from './worker-dock-activity'
import {
  readWorkerDockElsewhere,
  workerDockElsewhereReadyCandidates,
  workerDockReadyUnverified,
  type WorkerDockElsewhereRead
} from './worker-dock-elsewhere'
import {
  backfillWorkerDockDelegations,
  workerDockDelegationsBackfilled
} from './worker-dock-delegations'
import { workerDockDelegationWake } from './worker-dock-delegation-wake'

const stateSql = `CASE f.state
  WHEN 'ready' THEN 'unavailable' WHEN 'succeeded' THEN CASE WHEN f.result_lost_at IS NOT NULL THEN 'unavailable' ELSE 'saving' END
  WHEN 'abandoned' THEN 'unexpected'
  WHEN 'start_unknown' THEN 'unavailable' WHEN 'stop_unknown' THEN 'unavailable'
  ELSE f.state END`
const identitySql = `json_array(f.home, f.source, 'worker', f.dispatch_id)`
const Metadata = lazyZodSchema(() =>
  z.object({
    id: z.string(),
    dispatchId: z.string(),
    state: WorkerDockEntry.shape.state,
    changedAt: z.number().nullable(),
    ownerActionsAvailable: z.coerce.boolean(),
    hasModel: z.coerce.boolean(),
    settlement: z.string().nullable()
  })
)

export type WorkerDockReadOptions = {
  /** Refreshes other chats' counted ready workers' activity (pane reads) before counting them. */
  refreshElsewhere?: (ready: ReadonlyMap<string, readonly string[]>) => void
  /** Receives what the Other chats rows were read from, for a stream to watch. */
  onElsewhere?: (read: WorkerDockElsewhereRead) => void
}

function unrefreshed(
  ready: ReadonlyMap<string, readonly string[]>,
  refreshed: ReadonlyMap<string, readonly string[]>
): boolean {
  return [...ready].some(([owner, ids]) => {
    const done = refreshed.get(owner)
    return !done || ids.some((id) => !done.includes(id))
  })
}

export function readWorkerDock(
  db: OrchestrationDb,
  request: z.infer<typeof WorkerDockRead>,
  options: WorkerDockReadOptions = {}
): WorkerDockSnapshot {
  if (request.currentOnly !== true) {
    return readWorkerDockOnce(db, request).snapshot
  }
  const source = workerDockSession(request.party)
  // The one-time backfill commits on its own, never inside this read's snapshot transaction.
  if (!workerDockDelegationsBackfilled(db)) {
    if (db.db.isTransaction) {
      workerDockDelegationWake(db).requestBackfill()
    } else {
      const sources = backfillWorkerDockDelegations(db)
      for (const other of sources ?? []) {
        db.workerDockSources.invalidate(other)
      }
      if (sources?.length) {
        db.crewChanges.notify(new Set(['topology']))
      }
    }
  }
  // Phase one: other chats' counted ready workers get their activity before they are counted.
  const refresh = db.db.isTransaction ? undefined : options.refreshElsewhere
  const refreshed = refresh ? workerDockElsewhereReadyCandidates(db, source) : new Map()
  refresh?.(refreshed)
  let read = readWorkerDockOnce(db, request)
  // A worker became ready in between: refresh it and read once more.
  if (refresh && read.elsewhere && unrefreshed(read.elsewhere.ready, refreshed)) {
    refresh(read.elsewhere.ready)
    read = readWorkerDockOnce(db, request)
  }
  if (read.elsewhere) {
    options.onElsewhere?.(read.elsewhere)
  }
  return read.snapshot
}

function readWorkerDockOnce(
  db: OrchestrationDb,
  request: z.infer<typeof WorkerDockRead>
): { snapshot: WorkerDockSnapshot; elsewhere?: WorkerDockElsewhereRead } {
  return readWorkerDockSnapshot(db.db, () => {
    const source = workerDockSession(request.party)
    // The source version also advances when time alone changes roster membership.
    const revision =
      z
        .object({ revision: z.number() })
        .parse(db.db.prepare('SELECT revision FROM worker_dock_revision WHERE id = 1').get())
        .revision +
      workerDockActivityRevision(db) +
      db.workerDockSources.version(source)
    const activity = readWorkerDockActivity(db, source)
    const current = request.currentOnly === true
    const now = Date.now()
    const candidates = current
      ? `(${workerDockCurrentRowsSql}) f`
      : `worker_dock_facts f INDEXED BY worker_dock_eligible WHERE ${workerDockEligibleSql}`
    let nextExpiry: number | undefined
    let hasUnverifiedWorkers = false
    // Unsettled workers the roster omits can still change state, so their source must stay routable.
    const omitted: string[] =
      current && db.workerDockSources.needsDispatchSeed(source)
        ? db.db
            .prepare(
              `SELECT dispatch_id FROM worker_dock_facts INDEXED BY worker_dock_source_state_time
              WHERE source = ? AND state IN ('start_unknown', 'stop_unknown')
                AND (changed_at IS NULL OR changed_at <= ?)`
            )
            .all(source, now - WORKER_DOCK_UNKNOWN_MS)
            .map((row) => String(row.dispatch_id))
        : []
    const identities: WorkerDockSnapshot['identities'] = db.db
      .prepare(`SELECT ${identitySql} AS id, f.dispatch_id AS dispatchId,
      ${stateSql} AS state, f.changed_at AS changedAt, f.settlement, (f.model IS NOT NULL AND length(trim(f.model)) > 0) AS hasModel,
      NOT EXISTS(SELECT 1 FROM federated_dispatches remote WHERE remote.dispatch_id = f.dispatch_id) AS ownerActionsAvailable,
      f.state AS lifecycleState FROM ${candidates}`)
      .all(
        ...(current
          ? [source, source, now - WORKER_DOCK_UNKNOWN_MS, source, now - WORKER_DOCK_FAILURE_MS]
          : [source])
      )
      .flatMap((row) => {
        const identity = Metadata.parse(row)
        const ready = row.lifecycleState === 'ready'
        const live = ready ? activity?.get(identity.dispatchId) : undefined
        if (current) {
          // An exited worker's dispatch is still open, so it ages out like an unverifiable one.
          const unverified = ready && workerDockReadyUnverified(activity, live)
          const window = unverified
            ? WORKER_DOCK_UNVERIFIED_READY_MS
            : row.lifecycleState === 'start_unknown' || row.lifecycleState === 'stop_unknown'
              ? WORKER_DOCK_UNKNOWN_MS
              : identity.state === 'failed' || identity.state === 'unexpected'
                ? WORKER_DOCK_FAILURE_MS
                : undefined
          if (window !== undefined) {
            const expires = (identity.changedAt ?? 0) + window
            if (expires <= now) {
              hasUnverifiedWorkers ||= unverified
              omitted.push(identity.dispatchId)
              return []
            }
            nextExpiry = Math.min(nextExpiry ?? expires, expires)
          }
        }
        return [live ? { ...identity, state: live.state, changedAt: live.changedAt } : identity]
      })
    const providerFailures = current ? null : readProviderFailureIdentities(db, source)
    if (providerFailures?.length) {
      identities.push(...providerFailures)
    }
    identities.sort(compareWorkerDockEntries)
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
      EXISTS(SELECT 1 FROM federated_dispatches remote WHERE remote.dispatch_id = f.dispatch_id) AS remote, d.last_failure, d.progress_note, COALESCE(t.task_title, t.spec) AS title, t.display_name
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
      const agent = workerStartOptionsAgentValue(launch)
      const active = row.state === 'starting' || row.state === 'ready'
      return WorkerDockEntry.parse({
        ...identity,
        source,
        name: row.display_name ?? launch.name ?? agent ?? 'Worker',
        title: row.title,
        ...(agent ? { agent } : {}),
        model: workerLaunchModel(launch.launch),
        changedAt: identity.changedAt,
        startedAt: epoch(row.created_at),
        reason: row.reason ?? null,
        ...(active && typeof row.progress_note === 'string' && row.progress_note
          ? { progressNote: row.progress_note }
          : {}),
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
    // Other chats rows: current reads only, so an older client's full read neither sees nor clears them.
    const elsewhere = current ? readWorkerDockElsewhere(db, source, now) : undefined
    const expiry =
      elsewhere?.nextExpiry === undefined
        ? nextExpiry
        : Math.min(nextExpiry ?? elsewhere.nextExpiry, elsewhere.nextExpiry)
    const snapshot: WorkerDockSnapshot = {
      revision,
      currentOnly: current ? true : undefined,
      nextExpiry: expiry,
      hasUnverifiedWorkers: hasUnverifiedWorkers || undefined,
      ...(elsewhere?.elsewhere.length ? { elsewhere: elsewhere.elsewhere } : {}),
      ...(elsewhere?.relations ? { relations: true as const } : {}),
      ...(elsewhere?.hasUnverifiedElsewhere ? { hasUnverifiedElsewhere: true as const } : {}),
      expired: request.revision !== undefined && request.revision !== revision,
      identities,
      rows,
      anchor: identities[center]?.id ?? null
    }
    db.workerDockSources.rememberSnapshot(
      source,
      snapshot,
      omitted,
      elsewhere
        ? {
            elsewhereOpen:
              elsewhere.elsewhere.length > 0 ||
              elsewhere.relations ||
              elsewhere.hasUnverifiedElsewhere,
            // Not while earlier handoffs are still to be backfilled: a later seed reads again.
            seeded: workerDockDelegationsBackfilled(db)
          }
        : undefined
    )
    if (elsewhere) {
      db.workerDockSources.rememberElsewhereDispatches(elsewhere.counted)
    }
    return { snapshot, ...(elsewhere ? { elsewhere } : {}) }
  })
}
