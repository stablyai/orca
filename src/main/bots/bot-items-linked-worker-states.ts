// Linked Dispatches' workers with their reports and stop reasons. Finished local workers are kept between
// reads and checked each read against one batched fingerprint of their rows, so the item views and the
// usage-limit pass re-read only running workers and workers whose rows changed.
import type { WorkerLineage } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { readWorkerDockReasons } from '../runtime/orchestration/dock/worker-dock-read'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotWorkWorker } from './bot-work-types'
import { readWorkers } from './bot-work-workers-read'
import { dataVersion, dockRevision, printKey, readPrints } from './bot-items-linked-worker-prints'

export type LinkedWorkerState = {
  worker: BotWorkWorker | null
  report: { subject: string; body: string | null } | null
  /** Why it ended, as the chat's worker strip shows it. */
  reason?: string | null
}

/** A big profile's linked Dispatches (thousands) stay kept, within a few MB in all: a worker whose own
 *  read is longer isn't kept, and reports past their budget are read from the Task on use. */
const KEPT_MAX = 8_192
const KEPT_WORKER_MAX_CHARS = 512
const KEPT_REPORT_MAX_CHARS = 1_000_000
const FINISHED_STATES = new Set<BotWorkWorker['state']>(['completed', 'failed', 'stopped'])

type Kept = {
  worker: BotWorkWorker
  /** Undefined: too long to keep, read from its Task on use. */
  report: LinkedWorkerState['report'] | undefined
  /** Its newest Dispatch and that worker's resource, whose rows the fingerprint covers. */
  dispatchId: string
  resourceId: string | null
  /** The Dispatches whose row notices drop it: the linked one, the newest and the one it shows. */
  notedBy: readonly string[]
  print: number
  reason: string | null
  /** The database's state the fingerprint last matched in: unchanged since, it isn't read again. */
  checkedAt: string
  /** The kept report's length, counted against its budget. */
  chars: number
}

export class LinkedWorkerStates {
  private readonly kept = new Map<string, Kept>()
  /** Kept refs by the Dispatches in their `notedBy`, so a notice naming one drops them at once. */
  private readonly refsOf = new Map<string, Set<string>>()
  private keptChars = 0
  private source: unknown = null
  /** Counts the database's row notices: a read that saw one while it ran keeps nothing. */
  private writes = 0

  constructor(private readonly workRuntime: BotWorkRuntime) {}

  /** Any write to a Dispatch's rows, or a paired server's verdict on one: kept reads ending at it go, since
   *  a fingerprint shows only the length and ends of long text such as a rewritten report. */
  noteWrite(dispatchIds: readonly string[] = [], deleted = false): void {
    this.writes += 1
    // A deleted Dispatch may be any link in a kept lineage's chain, which no index covers.
    if (deleted) {
      this.forgetAll()
    }
    for (const dispatchId of dispatchIds) {
      for (const ref of this.refsOf.get(dispatchId) ?? []) {
        this.forget(ref)
      }
    }
  }

  /** Each ref's worker, report and stop reason: kept ones when their rows are unchanged, the rest read in
   *  one batch. Left out when unreadable; null when its records are gone. */
  async readStates(unique: readonly string[]): Promise<Map<string, LinkedWorkerState | null>> {
    const db = this.workRuntime.getOrchestrationDb()
    if (db !== this.source) {
      this.forgetAll()
      this.source = db
    }
    const writes = this.writes
    // Row notices, other connections' commits (which fire none here) and the dock's own revision: with
    // none since a kept worker was last checked, its rows are unchanged and no fingerprint is read.
    const version = dataVersion(db)
    const stamp = version === null ? null : `${writes}:${version}:${dockRevision(db)}`
    const states = new Map<string, LinkedWorkerState | null>()
    const candidates = unique.flatMap((ref) => {
      const kept = this.kept.get(ref)
      return kept ? [[ref, kept] as const] : []
    })
    const prints = readPrints(
      db,
      candidates.flatMap(([, kept]) => (kept.checkedAt === stamp ? [] : [kept]))
    )
    const missing = unique.filter((ref) => !this.kept.has(ref))
    const reports = new Map<string, LinkedWorkerState['report'] | undefined>()
    const readReport = (taskId: string) => {
      if (!reports.has(taskId)) {
        reports.set(taskId, this.report(taskId))
      }
      return reports.get(taskId)
    }
    const hits: [string, Kept][] = []
    for (const [ref, kept] of candidates) {
      if (kept.checkedAt !== stamp) {
        const now = prints.get(printKey(kept))
        if (stamp === null || now?.print !== kept.print) {
          this.forget(ref)
          missing.push(ref)
          continue
        }
        kept.reason = now.reason
        kept.checkedAt = stamp
      }
      // Most recently used last, so the oldest falls out first.
      this.kept.delete(ref)
      this.kept.set(ref, kept)
      hits.push([ref, kept])
      const report = kept.report === undefined ? readReport(kept.worker.taskId) : kept.report
      states.set(ref, { worker: kept.worker, report: report ?? null, reason: kept.reason })
    }
    const lineageOf = new Map<string, WorkerLineage>()
    const workers =
      missing.length > 0 ? await readWorkers(this.workRuntime, missing, lineageOf) : new Map()
    const reasons = readWorkerDockReasons(
      db,
      [...workers.values()].flatMap((worker) => worker?.dispatchId ?? [])
    )
    if (this.writes !== writes) {
      // A Task written while the walk ran: kept workers show its report as of now.
      reports.clear()
      for (const [ref, kept] of hits) {
        states.set(ref, {
          worker: kept.worker,
          report: readReport(kept.worker.taskId) ?? null,
          reason: kept.reason
        })
      }
    }
    const finished: [string, Kept][] = []
    let finishedChars = 0
    for (const [ref, worker] of workers) {
      if (!worker) {
        states.set(ref, null)
        continue
      }
      // A server worker shows no report, even when a local retry of its Task has one.
      const read = worker.host === 'local' ? readReport(worker.taskId) : null
      states.set(ref, {
        worker,
        report: read ?? null,
        reason: reasons.get(worker.dispatchId) ?? null
      })
      const lineage = lineageOf.get(ref)
      const resource = lineage?.resource
      if (
        stamp !== null &&
        read !== undefined &&
        lineage &&
        worker.host === 'local' &&
        lineage.latest.status !== 'pending' &&
        lineage.latest.status !== 'dispatched' &&
        FINISHED_STATES.has(worker.state) &&
        // A worker still on a pane reads as the fleet sees every Dispatch on it, so it stays live.
        (!resource || resource.ownership_state === 'released')
      ) {
        if (JSON.stringify(worker).length <= KEPT_WORKER_MAX_CHARS) {
          // Over the budget, the report is read from its Task on use, so it is never copied.
          const fits = this.keptChars + finishedChars + reportLength(read) <= KEPT_REPORT_MAX_CHARS
          const chars = fits ? reportLength(read) : 0
          finishedChars += chars
          // A copy: a kept substring would otherwise pin the whole Task spec or result it was cut from.
          finished.push([
            ref,
            {
              ...structuredClone({ worker, report: fits ? read : undefined }),
              dispatchId: lineage.latest.id,
              resourceId: resource?.id ?? null,
              notedBy: [...new Set([ref, lineage.latest.id, worker.dispatchId])],
              print: 0,
              reason: reasons.get(worker.dispatchId) ?? null,
              checkedAt: stamp ?? '',
              chars
            }
          ])
        }
      }
    }
    const finishedPrints = readPrints(
      db,
      finished.map(([, kept]) => kept)
    )
    // Rows written since the read began, its fingerprints included, may be newer than what it saw.
    if (`${this.writes}:${dataVersion(db)}:${dockRevision(db)}` === stamp) {
      for (const [ref, kept] of finished) {
        const print = finishedPrints.get(printKey(kept))?.print
        if (print !== undefined) {
          this.keep(ref, { ...kept, print })
        }
      }
    }
    return states
  }

  private keep(ref: string, kept: Kept): void {
    this.forget(ref)
    for (const oldest of this.kept.keys()) {
      if (this.kept.size < KEPT_MAX) {
        break
      }
      this.forget(oldest)
    }
    const value =
      this.keptChars + kept.chars <= KEPT_REPORT_MAX_CHARS
        ? kept
        : { ...kept, report: undefined, chars: 0 }
    this.kept.set(ref, value)
    this.keptChars += value.chars
    for (const dispatchId of value.notedBy) {
      const refs = this.refsOf.get(dispatchId) ?? new Set()
      refs.add(ref)
      this.refsOf.set(dispatchId, refs)
    }
  }

  private forget(ref: string): void {
    const kept = this.kept.get(ref)
    if (kept) {
      this.kept.delete(ref)
      this.keptChars -= kept.chars
      for (const dispatchId of kept.notedBy) {
        const refs = this.refsOf.get(dispatchId)
        refs?.delete(ref)
        if (refs?.size === 0) {
          this.refsOf.delete(dispatchId)
        }
      }
    }
  }

  private forgetAll(): void {
    this.kept.clear()
    this.refsOf.clear()
    this.keptChars = 0
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

function reportLength(report: LinkedWorkerState['report']): number {
  return report ? report.subject.length + (report.body?.length ?? 0) : 0
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
