// Linked Dispatches' workers with their reports and stop reasons. Finished local workers are kept between
// reads and checked each read against one batched fingerprint of their rows, so the item views and the
// usage-limit pass re-read only running workers and workers whose rows changed.
import type { WorkerLineage } from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import {
  DISPATCH_CONTEXT_COLUMNS,
  TASK_COLUMNS,
  WORKER_DISPATCH_COLUMNS,
  WORKER_TERMINAL_RESOURCE_COLUMNS
} from '../runtime/orchestration/db/row-column-lists'
import { readWorkerDockReasons } from '../runtime/orchestration/dock/worker-dock-read'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotWorkWorker } from './bot-work-types'
import { readWorkers } from './bot-work-workers-read'

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
  print: number
  reason: string | null
  /** The database's state the fingerprint last matched in: unchanged since, it isn't read again. */
  checkedAt: string
  /** The kept report's length, counted against its budget. */
  chars: number
}

export class LinkedWorkerStates {
  private readonly kept = new Map<string, Kept>()
  /** Kept refs by their newest Dispatch, so that Dispatch's row notice drops them at once. */
  private readonly refsOf = new Map<string, Set<string>>()
  private keptChars = 0
  private source: unknown = null
  /** Counts the database's row notices: a read that saw one while it ran keeps nothing. */
  private writes = 0

  constructor(private readonly workRuntime: BotWorkRuntime) {}

  /** Any write to a Dispatch's rows, or a paired server's verdict on one: kept reads ending at it go, since
   *  a fingerprint shows only the length and ends of long text such as a rewritten report. */
  noteWrite(dispatchIds: readonly string[] = []): void {
    this.writes += 1
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
      const report = kept.report === undefined ? this.report(kept.worker.taskId) : kept.report
      states.set(ref, { worker: kept.worker, report: report ?? null, reason: kept.reason })
    }
    const lineageOf = new Map<string, WorkerLineage>()
    const workers =
      missing.length > 0 ? await readWorkers(this.workRuntime, missing, lineageOf) : new Map()
    const reasons = readWorkerDockReasons(
      db,
      [...workers.values()].flatMap((worker) => worker?.dispatchId ?? [])
    )
    const reports = new Map<string, LinkedWorkerState['report'] | undefined>()
    const finished: [string, Kept][] = []
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
          // A copy: a kept substring would otherwise pin the whole Task spec or result it was cut from.
          finished.push([
            ref,
            {
              ...structuredClone({ worker, report: read }),
              dispatchId: lineage.latest.id,
              resourceId: resource?.id ?? null,
              print: 0,
              reason: reasons.get(worker.dispatchId) ?? null,
              checkedAt: stamp ?? '',
              chars: reportLength(read)
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
    const refs = this.refsOf.get(value.dispatchId) ?? new Set()
    refs.add(ref)
    this.refsOf.set(value.dispatchId, refs)
  }

  private forget(ref: string): void {
    const kept = this.kept.get(ref)
    if (kept) {
      this.kept.delete(ref)
      this.keptChars -= kept.chars
      const refs = this.refsOf.get(kept.dispatchId)
      refs?.delete(ref)
      if (refs?.size === 0) {
        this.refsOf.delete(kept.dispatchId)
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

/** Text that can be long counts by its length and ends; every other column by its value. */
const LONG_COLUMNS = new Set([
  'last_failure',
  'origin_ref',
  'chat_lineage',
  'effects',
  'residual_resources',
  'start_options',
  'last_error',
  'prior_owner_dispatch_ids',
  'resume_session',
  'spec',
  'result'
])

function rowPrint(alias: string, columns: readonly string[]): string {
  return columns
    .map((column) => {
      const value = `${alias}.${column}`
      return LONG_COLUMNS.has(column)
        ? `ifnull(length(${value}) || substr(${value}, 1, 24) || substr(${value}, -24), '~')`
        : `ifnull(${value}, '~')`
    })
    .join(' || char(31) || ')
}

// Every row a finished worker's read rests on: its newest Dispatch, worker, resource and Task, any
// resource it now owns, a follow-up that continues it, and a paired-server record of it.
const PRINT_SQL = `SELECT j.key AS i,
  (SELECT ${rowPrint('d', DISPATCH_CONTEXT_COLUMNS)} FROM dispatch_contexts d WHERE d.id = json_extract(j.value, '$.d'))
  || char(30) || ifnull((SELECT ${rowPrint('w', WORKER_DISPATCH_COLUMNS)} FROM worker_dispatches w WHERE w.dispatch_id = json_extract(j.value, '$.d')), '-')
  || char(30) || ifnull((SELECT ${rowPrint('r', WORKER_TERMINAL_RESOURCE_COLUMNS)} FROM worker_terminal_resources r WHERE r.id = json_extract(j.value, '$.r')), '-')
  || char(30) || ifnull((SELECT group_concat(o.id) FROM worker_terminal_resources o WHERE o.owner_dispatch_id = json_extract(j.value, '$.d')), '-')
  || char(30) || ifnull((SELECT ${rowPrint('t', TASK_COLUMNS)} FROM dispatch_contexts td JOIN tasks t ON t.id = td.task_id WHERE td.id = json_extract(j.value, '$.d')), '-')
  || char(30) || EXISTS(SELECT 1 FROM dispatch_contexts f WHERE f.follow_up_of_dispatch_id = json_extract(j.value, '$.d'))
  || char(30) || EXISTS(SELECT 1 FROM federated_dispatches fd WHERE fd.dispatch_id = json_extract(j.value, '$.d')) AS print,
  (SELECT reason FROM worker_dock_facts WHERE dispatch_id = json_extract(j.value, '$.d')) AS reason
  FROM json_each(?) j`

function printKey(kept: Pick<Kept, 'dispatchId' | 'resourceId'>): string {
  return `${kept.dispatchId}\0${kept.resourceId ?? ''}`
}

/** Each kept worker's rows as one number, and its stop reason, in one read; a missing row reads as none. */
function readPrints(
  db: OrchestrationDb,
  kept: readonly Pick<Kept, 'dispatchId' | 'resourceId'>[]
): Map<string, { print: number; reason: string | null }> {
  const keys = [...new Set(kept.map(printKey))]
  if (keys.length === 0) {
    return new Map()
  }
  const asked = keys.map((key) => {
    const [d, r] = key.split('\0')
    return { d, r: r || null }
  })
  try {
    const rows = db.db.prepare(PRINT_SQL).all(JSON.stringify(asked))
    const prints = new Map<string, { print: number; reason: string | null }>()
    for (const row of rows) {
      if (typeof row.print === 'string') {
        prints.set(keys[Number(row.i)], {
          print: hashText(row.print),
          reason: typeof row.reason === 'string' ? row.reason : null
        })
      }
    }
    return prints
  } catch {
    return new Map()
  }
}

/** A 53-bit string hash (cyrb53): a fingerprint compares as one number, not the text it came from. */
function hashText(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 2654435761)
    h2 = Math.imul(h2 ^ c, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
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

/** SQLite's count of commits other connections made to this database; null when unreadable. */
function dataVersion(db: OrchestrationDb): number | null {
  try {
    const row = db.db.prepare('PRAGMA data_version').get()
    return typeof row?.data_version === 'number' ? row.data_version : null
  } catch {
    return null
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
