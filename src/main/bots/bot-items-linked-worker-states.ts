// Linked Dispatches' workers with their reports and stop reasons. Finished local workers are kept between
// reads and checked each read against one batched fingerprint of their rows, so the item views and the
// usage-limit pass re-read only running workers and workers whose rows changed.
import type { WorkerLineage } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { readWorkerDockReasons } from '../runtime/orchestration/dock/worker-dock-read'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotWorkWorker } from './bot-work-types'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { readWorkers } from './bot-work-workers-read'
import { dataVersion, dockRevision, printKey, readPrints } from './bot-items-linked-worker-prints'
import {
  finishedOf,
  firstOf,
  plainChain,
  reportLength,
  taskReport,
  type Finished
} from './bot-items-linked-worker-admission'

export type LinkedWorkerState = {
  worker: BotWorkWorker | null
  report: { subject: string; body: string | null } | null
  /** Why it ended, as the chat's worker strip shows it. */
  reason?: string | null
}

/** A big profile's linked Dispatches (thousands) stay kept: a few MB for real workers, at most ~32 MB
 *  if every one were at the worker limit. Reports past their budget are read from the Task on use. */
const KEPT_MAX = 8_192
const KEPT_WORKER_MAX_CHARS = 2_048
const KEPT_REPORT_MAX_CHARS = 1_000_000
/** Workers kept per turn after a read, so keeping a cold profile's thousands never stalls a frame. */
const KEEP_SLICE = 256

type Kept = {
  worker: BotWorkWorker
  /** Undefined: too long to keep, read from its Task on use. */
  report: LinkedWorkerState['report'] | undefined
  /** Its newest Dispatch and that worker's resource, whose rows the fingerprint covers. */
  dispatchId: string
  resourceId: string | null
  /** The Dispatches whose row notices drop it: its follow-up chain and the one it shows. */
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
  /** The last `PRAGMA data_version` a read saw. */
  private version: number | null = null
  /** Counts the database's row notices: a read that saw one while it ran keeps nothing. */
  private writes = 0
  /** Finished workers reads found, kept a slice per turn once their callers replied; one queue, so
   *  overlapping reads never clone or fingerprint a worker twice. */
  private pending: { db: OrchestrationDb; stamp: string; items: Map<string, Finished> } | null =
    null
  private draining = false

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
  async readStates(unique: readonly string[]): Promise<{
    states: Map<string, LinkedWorkerState | null>
    keep: () => void
    stale: () => boolean
  }> {
    const db = this.workRuntime.getOrchestrationDb()
    if (db !== this.source) {
      this.forgetAll()
      this.source = db
    }
    // Row notices, other connections' commits (which fire none here) and the dock's own revision: with
    // none since a kept worker was last checked, its rows are unchanged and no fingerprint is read.
    // Another connection's commit fires no notice here, and a fingerprint misses a rewrite inside long text.
    const stamp = this.syncStamp(db)
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
    }
    const lineageOf = new Map<string, WorkerLineage>()
    const workers =
      missing.length > 0 ? await readWorkers(this.workRuntime, missing, lineageOf) : new Map()
    // A write while the read awaited may have changed a kept worker. If it did, the whole batch is read
    // again, so links sharing a lineage never disagree within one read.
    let used = hits
    if (this.changedSince(db, stamp, hits)) {
      used = []
      workers.clear()
      for (const [ref, worker] of await readWorkers(this.workRuntime, unique, lineageOf)) {
        workers.set(ref, worker)
      }
    }
    for (const [ref, kept] of used) {
      const report = kept.report === undefined ? readReport(kept.worker.taskId) : kept.report
      states.set(ref, { worker: kept.worker, report: report ?? null, reason: kept.reason })
    }
    const reasons = readWorkerDockReasons(
      db,
      [...workers.values()].flatMap((worker) => worker?.dispatchId ?? [])
    )
    const finished: Finished[] = []
    let pendingChars = 0
    for (const [ref, worker] of workers) {
      if (!worker) {
        states.set(ref, null)
        continue
      }
      // A server worker shows no report, even when a local retry of its Task has one.
      const read = worker.host === 'local' ? readReport(worker.taskId) : null
      const reason = reasons.get(worker.dispatchId) ?? null
      states.set(ref, { worker, report: read ?? null, reason })
      // Only reports within the budget wait to be kept; the rest are read from their Task on use.
      const fits = this.keptChars + pendingChars + reportLength(read) <= KEPT_REPORT_MAX_CHARS
      const item =
        read === undefined
          ? null
          : finishedOf(ref, worker, fits ? read : undefined, reason, lineageOf.get(ref))
      if (item) {
        pendingChars += fits ? reportLength(read) : 0
        finished.push(item)
      }
    }
    const readAt = this.stampOf(db)
    return {
      states,
      // Run once the caller has replied: keeping costs a cold read nothing over reading.
      keep: () => {
        if (stamp !== null && readAt === stamp && finished.length > 0) {
          this.queue(db, stamp, finished)
        }
      },
      // A kept worker this read used changed before its caller replied: read it again.
      stale: () => this.changedSince(db, readAt, used)
    }
  }

  /** Whether a write since `stamp` changed any of these kept workers; those that changed are dropped,
   *  the rest are checked as of now. */
  private changedSince(
    db: OrchestrationDb,
    stamp: string | null,
    hits: readonly (readonly [string, Kept])[]
  ): boolean {
    const now = this.syncStamp(db)
    // Unmoved, nothing invalidated them (one version read; an eviction loses no freshness).
    if (now === stamp || hits.length === 0) {
      return false
    }
    const prints = readPrints(
      db,
      hits.map(([, kept]) => kept)
    )
    const changed = hits.filter(([ref, kept]) => {
      const print = prints.get(printKey(kept))
      if (this.kept.get(ref) !== kept || now === null || print?.print !== kept.print) {
        this.forget(ref)
        return true
      }
      kept.reason = print.reason
      kept.checkedAt = now
      return false
    })
    return changed.length > 0
  }

  private queue(db: OrchestrationDb, stamp: string, finished: readonly Finished[]): void {
    if (this.pending?.db !== db || this.pending.stamp !== stamp) {
      this.pending = { db, stamp, items: new Map() }
    }
    for (const item of finished) {
      this.pending.items.set(item.ref, item)
    }
    if (!this.draining) {
      this.draining = true
      setImmediate(() => this.keepLater())
    }
  }

  /** Keeps a slice of the queue per turn while no write has landed since its reads began; each slice
   *  re-checks after its fingerprints are read. */
  private keepLater(): void {
    const pending = this.pending
    const db = this.workRuntime.getOrchestrationDb()
    if (!pending || pending.db !== db || this.stampOf(db) !== pending.stamp) {
      this.pending = null
      this.draining = false
      return
    }
    const slice: [string, Kept][] = []
    let sliceChars = 0
    for (const item of firstOf(pending.items.values(), KEEP_SLICE)) {
      pending.items.delete(item.ref)
      const chain = this.kept.has(item.ref) ? null : plainChain(db, item)
      if (!chain || JSON.stringify(item.worker).length > KEPT_WORKER_MAX_CHARS) {
        continue
      }
      // Over the budget, the report is read from its Task on use, so it is never copied.
      const fits = this.keptChars + sliceChars + reportLength(item.report) <= KEPT_REPORT_MAX_CHARS
      const chars = fits ? reportLength(item.report) : 0
      sliceChars += chars
      // A copy: a kept substring would otherwise pin the whole Task spec or result it was cut from.
      slice.push([
        item.ref,
        {
          ...structuredClone({ worker: item.worker, report: fits ? item.report : undefined }),
          dispatchId: item.latestId,
          resourceId: item.resource?.id ?? null,
          notedBy: [...new Set([...chain, item.worker.dispatchId])],
          print: 0,
          reason: item.reason,
          checkedAt: pending.stamp,
          chars
        }
      ])
    }
    const prints = readPrints(
      db,
      slice.map(([, kept]) => kept)
    )
    if (this.stampOf(db) === pending.stamp) {
      for (const [ref, kept] of slice) {
        const print = prints.get(printKey(kept))?.print
        if (print !== undefined) {
          this.keep(ref, { ...kept, print })
        }
      }
    }
    if (pending.items.size > 0) {
      setImmediate(() => this.keepLater())
    } else {
      this.pending = null
      this.draining = false
    }
  }

  /** Another connection's commit fires no notice here, and a fingerprint misses a rewrite inside long
   *  text: it drops every kept worker. */
  /** The stamp as of now, from one `data_version` read, having dropped every kept worker when it moved. */
  private syncStamp(db: OrchestrationDb): string | null {
    const version = dataVersion(db)
    if (version !== this.version) {
      this.forgetAll()
      this.version = version
    }
    return this.stampOf(db, version)
  }

  private stampOf(db: OrchestrationDb, version = dataVersion(db)): string | null {
    return version === null ? null : `${this.writes}:${version}:${dockRevision(db)}`
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
