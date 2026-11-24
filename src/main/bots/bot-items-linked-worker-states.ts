// Linked Dispatches' workers with their reports and stop reasons, settled ones kept between reads so
// the item views and the usage-limit pass re-read only running workers and lineages written since.
import type { OrchestrationSessionWorker } from '../../shared/orchestration-session-workers'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { DispatchRowChange } from '../runtime/orchestration/db/worker-status-notice'
import { readWorkerDockReasons } from '../runtime/orchestration/dock/worker-dock-read'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotWorkWorker } from './bot-work-types'
import { readWorkers, type WorkerReadTrace } from './bot-work-workers-read'
import {
  SETTLED_WORKER_STATES,
  SettledDispatchReadCache,
  workerStatusEvidence
} from './settled-dispatch-read-cache'

export type LinkedWorkerState = {
  worker: BotWorkWorker | null
  report: { subject: string; body: string | null } | null
  /** Why it ended, as the chat's worker strip shows it. */
  reason?: string | null
}

/** Every linked Dispatch of a big profile (thousands) stays kept. */
const KEPT_WORKERS_MAX = 16_384
const KEPT_SCOPE = 'items'
/** A longer report is read again with each pass, so thousands of kept workers never pin their reports. */
const KEPT_REPORT_MAX_CHARS = 2_000

/** A settled worker's read, kept until a Dispatch its walk read is written. */
type KeptWorker = {
  worker: BotWorkWorker
  /** Undefined: too long to keep, read again from its Task. */
  report: LinkedWorkerState['report'] | undefined
  reason: string | null
  /** The dock's revision `reason` was read at; null: read again. */
  dockRevision: number | null
  session: Pick<OrchestrationSessionWorker, 'paneKey' | 'address'>
  evidence: string
}

export class LinkedWorkerStates {
  private readonly kept = new SettledDispatchReadCache<KeptWorker>(KEPT_WORKERS_MAX, true)

  constructor(private readonly workRuntime: BotWorkRuntime) {}

  /** The database's notice of a Dispatch row write: drops the kept reads that walked it. */
  rowChanged(dispatchId: string | null, change: DispatchRowChange): void {
    this.kept.rowChanged(dispatchId, change)
  }

  /** These Dispatches' rows or verdicts changed. */
  drop(dispatchIds: readonly string[]): void {
    this.kept.drop(dispatchIds)
  }

  /** Each ref's worker, report and stop reason: kept ones as kept, the rest read in one batch. Left out
   *  when unreadable; null when its records are gone. */
  async readStates(unique: readonly string[]): Promise<Map<string, LinkedWorkerState | null>> {
    const db = this.workRuntime.getOrchestrationDb()
    // A new follow-up continues its predecessor's worker: reads that walked it are read again.
    const inserts = this.kept.takeInserted()
    try {
      for (const inserted of inserts) {
        const before = db.getDispatchContextById(inserted)?.follow_up_of_dispatch_id
        if (before) {
          this.kept.drop(before)
        }
      }
    } catch (error) {
      // An unread insert may continue any kept read.
      this.kept.drop(null)
      throw error
    }
    const started = this.kept.begin(db)
    const evidenceOf = workerStatusEvidence(this.workRuntime.getAgentStatusSnapshotFn?.() ?? [])
    const hits = new Map<string, KeptWorker>()
    const missing: string[] = []
    for (const ref of unique) {
      const kept = this.kept.get(KEPT_SCOPE, ref)
      if (kept && evidenceOf(kept.session) === kept.evidence) {
        hits.set(ref, kept)
      } else {
        missing.push(ref)
      }
    }
    const trace: WorkerReadTrace = { walked: new Map(), latest: new Map(), sessions: new Map() }
    const workers =
      missing.length > 0 ? await readWorkers(this.workRuntime, missing, trace) : new Map()
    // Read together, with no wait between: the reasons are those of this revision.
    const revision = dockRevision(db)
    const staleReasons = [...hits.values()].filter(
      (kept) => revision === null || kept.dockRevision !== revision
    )
    const reasons = readWorkerDockReasons(db, [
      ...[...workers.values()].flatMap((worker) => worker?.dispatchId ?? []),
      ...staleReasons.map((kept) => kept.worker.dispatchId)
    ])
    for (const kept of staleReasons) {
      kept.reason = reasons.get(kept.worker.dispatchId) ?? null
      kept.dockRevision = revision
    }
    const states = new Map<string, LinkedWorkerState | null>()
    const longReports = readTaskReports(
      db,
      [...hits.values()].flatMap((kept) => (kept.report === undefined ? [kept.worker.taskId] : []))
    )
    for (const [ref, kept] of hits) {
      const report = kept.report === undefined ? longReports.get(kept.worker.taskId) : kept.report
      states.set(ref, { worker: kept.worker, report: report ?? null, reason: kept.reason })
    }
    // Undefined: the Task couldn't be read, so the read shows no report and isn't kept.
    const reports = new Map<string, LinkedWorkerState['report'] | undefined>()
    for (const [ref, worker] of workers) {
      if (!worker) {
        states.set(ref, null)
        continue
      }
      if (worker.host === 'local' && !reports.has(worker.taskId)) {
        reports.set(worker.taskId, this.report(worker.taskId))
      }
      // A server worker shows no report, even when a local retry of its Task has one.
      const read = worker.host === 'local' ? reports.get(worker.taskId) : null
      const report = read ?? null
      const reason = reasons.get(worker.dispatchId) ?? null
      states.set(ref, { worker, report, reason })
      const session = trace.sessions.get(worker.dispatchId)
      const latest = trace.latest.get(ref)
      const walked = latest && trace.walked.get(latest.id)
      if (
        read !== undefined &&
        session &&
        walked &&
        latest &&
        worker.host === 'local' &&
        latest.status !== 'pending' &&
        latest.status !== 'dispatched' &&
        SETTLED_WORKER_STATES.has(worker.state)
      ) {
        const value: KeptWorker = {
          worker,
          report: reportLength(report) <= KEPT_REPORT_MAX_CHARS ? report : undefined,
          reason,
          dockRevision: revision,
          session: { paneKey: session.paneKey, address: session.address },
          evidence: evidenceOf(session)
        }
        this.kept.set(KEPT_SCOPE, ref, value, latest.id, walked, started)
      }
    }
    return states
  }

  /** The report the worker ended with, as its Task recorded it (what worker cards show). */
  private report(taskId: string): LinkedWorkerState['report'] | undefined {
    try {
      return taskReport(this.workRuntime.getOrchestrationDb().getTask(taskId)?.result ?? null)
    } catch {
      return undefined
    }
  }
}

/** A Task's result: a worker's `{ subject, body }` report, or plain text. */
function taskReport(result: string | null): LinkedWorkerState['report'] {
  if (!result?.trim()) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(result)
    if (parsed && typeof parsed === 'object' && 'subject' in parsed) {
      const body = 'body' in parsed && typeof parsed.body === 'string' ? parsed.body : null
      return { subject: String(parsed.subject ?? ''), body }
    }
  } catch {
    // Plain text is its own report.
  }
  return { subject: result.trim(), body: null }
}

function reportLength(report: LinkedWorkerState['report']): number {
  return report ? report.subject.length + (report.body?.length ?? 0) : 0
}

/** These Tasks' reports in one read; a Task left out couldn't be read and shows none. */
function readTaskReports(
  db: OrchestrationDb,
  taskIds: readonly string[]
): Map<string, LinkedWorkerState['report']> {
  if (taskIds.length === 0) {
    return new Map()
  }
  try {
    const rows = db.db
      .prepare(
        'SELECT t.id, t.result FROM json_each(?) selected JOIN tasks t ON t.id = selected.value'
      )
      .all(JSON.stringify([...new Set(taskIds)]))
    return new Map(
      rows.map((row) => [
        String(row.id),
        taskReport(typeof row.result === 'string' ? row.result : null)
      ])
    )
  } catch {
    return new Map()
  }
}

/** The dock facts' revision, which every change to them bumps; null when unreadable. */
function dockRevision(db: OrchestrationDb): number | null {
  try {
    const row = db.db.prepare('SELECT revision FROM worker_dock_revision WHERE id = 1').get()
    return typeof row?.revision === 'number' ? row.revision : null
  } catch {
    return null
  }
}
