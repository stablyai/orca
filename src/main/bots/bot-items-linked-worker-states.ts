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
/** Kept reports, one per lineage's Task, stay under this many characters in all (about 1 MB); the rest are
 *  read again with each pass, so thousands of kept workers never pin thousands of reports. */
const KEPT_REPORTS_MAX_CHARS = 500_000

/** A settled worker's read, kept until a Dispatch its walk read is written. */
type KeptWorker = {
  worker: BotWorkWorker
  reason: string | null
  /** The dock's revision `reason` was read at; null: read again. */
  dockRevision: number | null
  session: Pick<OrchestrationSessionWorker, 'paneKey' | 'address'>
  evidence: string
}

export class LinkedWorkerStates {
  private readonly kept = new SettledDispatchReadCache<KeptWorker>(KEPT_WORKERS_MAX, true)
  /** Kept workers' reports by Task, oldest first; a Task write drops every read that shows it. */
  private readonly reports = new Map<string, LinkedWorkerState['report']>()
  private reportChars = 0
  /** The cache's reset count the reports were kept under. */
  private reportsAt = 0
  /** The database's count of commits by other connections, which no row notice reports. */
  private dataVersion: number | null = null

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
  async readStates(
    unique: readonly string[],
    /** False on the one re-read of hits a write dropped while this read ran. */
    recheck = true
  ): Promise<Map<string, LinkedWorkerState | null>> {
    const db = this.workRuntime.getOrchestrationDb()
    this.dropFollowedUp(db)
    // Another connection's write (a WSL move rewrites worktrees on its own) fires no notice here.
    const version = dataVersion(db)
    if (version === null || version !== this.dataVersion) {
      this.kept.drop(null)
      this.dataVersion = version
    }
    const started = this.kept.begin(db)
    if (this.kept.resets !== this.reportsAt) {
      // Every kept read went (a reset, another database): their reports go too.
      this.reports.clear()
      this.reportChars = 0
      this.reportsAt = this.kept.resets
    }
    const candidates = unique.map((ref) => [ref, this.kept.get(KEPT_SCOPE, ref)] as const)
    // One status snapshot for the whole read, taken before it so a kept read's evidence is what it saw;
    // none when nothing is read and no kept worker has a pane to check.
    const statusRows = candidates.some(
      ([, kept]) => !kept || kept.session.paneKey || kept.session.address
    )
      ? (this.workRuntime.getAgentStatusSnapshotFn?.() ?? [])
      : []
    const evidenceOf = workerStatusEvidence(statusRows)
    const hits = new Map<string, KeptWorker>()
    const missing: string[] = []
    for (const [ref, kept] of candidates) {
      if (kept && evidenceOf(kept.session) === kept.evidence) {
        hits.set(ref, kept)
      } else {
        missing.push(ref)
      }
    }
    const trace: WorkerReadTrace = {
      walked: new Map(),
      latest: new Map(),
      resources: new Map(),
      sessions: new Map(),
      statusRows
    }
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
    const unkept = readTaskReports(
      db,
      [...hits.values()].flatMap((kept) =>
        this.reports.has(kept.worker.taskId) ? [] : [kept.worker.taskId]
      )
    )
    for (const [ref, kept] of hits) {
      const report = this.reports.get(kept.worker.taskId) ?? unkept.get(kept.worker.taskId)
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
      if (read === undefined) {
        this.forgetReport(worker.taskId)
      }
      const reason = reasons.get(worker.dispatchId) ?? null
      states.set(ref, { worker, report, reason })
      const session = trace.sessions.get(worker.dispatchId)
      const latest = trace.latest.get(ref)
      const walked = latest && trace.walked.get(latest.id)
      const resource = trace.resources.get(ref)
      if (
        read !== undefined &&
        session &&
        walked &&
        latest &&
        worker.host === 'local' &&
        latest.status !== 'pending' &&
        latest.status !== 'dispatched' &&
        SETTLED_WORKER_STATES.has(worker.state) &&
        // A pane still bound reads as the fleet sees every Dispatch on it together, so it stays live.
        (!resource || resource.ownership_state === 'released' || !resource.pane_key)
      ) {
        this.keepReport(worker.taskId, report)
        const value: KeptWorker = {
          worker,
          reason,
          dockRevision: revision,
          session: { paneKey: session.paneKey, address: session.address },
          evidence: evidenceOf(session)
        }
        // A copy: a kept substring would otherwise pin the whole Task spec or result it was cut from.
        this.kept.set(KEPT_SCOPE, ref, structuredClone(value), latest.id, walked, started)
      }
    }
    if (recheck) {
      // A follow-up inserted while this read ran drops its predecessor's kept read before the check.
      this.dropFollowedUp(db)
    }
    const dropped = recheck
      ? [...hits].flatMap(([ref, kept]) => (this.kept.holds(KEPT_SCOPE, ref, kept) ? [] : [ref]))
      : []
    if (dropped.length > 0) {
      // Written while this read ran: what it kept from before is no longer current.
      const again = await this.readStates(dropped, false)
      for (const ref of dropped) {
        states.delete(ref)
        if (again.has(ref)) {
          states.set(ref, again.get(ref) ?? null)
        }
      }
    }
    return states
  }

  /** A new follow-up continues its predecessor's worker: reads that walked it are read again. */
  private dropFollowedUp(db: OrchestrationDb): void {
    const inserts = this.kept.takeInserted()
    try {
      for (const before of followedUp(db, inserts)) {
        this.kept.drop(before)
      }
    } catch (error) {
      // An unread insert may continue any kept read.
      this.kept.drop(null)
      throw error
    }
  }

  /** Keeps one copy of a Task's report within the budgets, dropping the oldest kept ones first. */
  private keepReport(taskId: string, report: LinkedWorkerState['report']): void {
    this.forgetReport(taskId)
    const size = reportLength(report)
    if (size > KEPT_REPORTS_MAX_CHARS) {
      return
    }
    for (const oldest of this.reports.keys()) {
      if (
        this.reportChars + size <= KEPT_REPORTS_MAX_CHARS &&
        this.reports.size < KEPT_WORKERS_MAX
      ) {
        break
      }
      this.forgetReport(oldest)
    }
    // A copy: a kept substring would otherwise pin the whole Task result it was cut from.
    this.reports.set(taskId, structuredClone(report))
    this.reportChars += size
  }

  private forgetReport(taskId: string): void {
    if (this.reports.has(taskId)) {
      this.reportChars -= reportLength(this.reports.get(taskId) ?? null)
      this.reports.delete(taskId)
    }
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

/** The Dispatches these inserted ones follow up, in one read. */
function followedUp(db: OrchestrationDb, inserted: readonly string[]): string[] {
  if (inserted.length === 0) {
    return []
  }
  const rows = db.db
    .prepare(
      `SELECT d.follow_up_of_dispatch_id AS before FROM json_each(?) inserted
        JOIN dispatch_contexts d ON d.id = inserted.value WHERE d.follow_up_of_dispatch_id IS NOT NULL`
    )
    .all(JSON.stringify(inserted))
  return rows.map((row) => String(row.before))
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

/** SQLite's count of commits other connections made to this database; null when unreadable. */
function dataVersion(db: OrchestrationDb): number | null {
  try {
    const row = db.db.prepare('PRAGMA data_version').get()
    return typeof row?.data_version === 'number' ? row.data_version : null
  } catch {
    return null
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
