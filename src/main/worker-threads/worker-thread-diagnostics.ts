import { join } from 'node:path'
import { getHeapSpaceStatistics, getHeapStatistics } from 'node:v8'
import type { Worker } from 'node:worker_threads'
import { crashReporter } from 'electron'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting/crash-reporting'
import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { resolveObservabilityConsent } from '../observability'
import { getLogsDirectory } from '../observability/logs-directory'
import {
  readWorkerSendLedger,
  setWorkerLargeSendLog,
  type WorkerSendLedgerEntry
} from './worker-send-ledger'
import type { WorkerThreadRole } from './worker-thread-roles'
import { observeWorkerThreads } from './worker-thread-spawn'
import { noteMainCageHeap } from '../crash-reporting/memory/main-heap-allocation-profile'

/**
 * The main thread and every worker share one V8 pointer cage (~3.25 GB measured on Electron 43):
 * when it fills, whichever isolate allocates next aborts the whole app. Committed heap per isolate
 * goes into the crash report's annotations, and a breadcrumb names the largest isolates once the
 * total is high, so the next such crash names the isolate that grew.
 */
const SAMPLE_INTERVAL_MS = 60_000
const PRESSURED_SAMPLE_INTERVAL_MS = 10_000
const PRESSURED_BYTES = 2 ** 30
const BREADCRUMB_BYTES = 1.5 * 2 ** 30
const BREADCRUMB_MIN_INTERVAL_MS = 10 * 60_000
const REPORTED_WORKERS = 4
/** A worker blocked in native code (SQLite) answers only when it returns to JS. */
const WORKER_HEAP_READ_TIMEOUT_MS = 2_000
/** Electron truncates crash annotation values past this many bytes. */
const ANNOTATION_MAX_LENGTH = 127
const MB = 2 ** 20

type LiveWorker = { worker: Worker; role: WorkerThreadRole; threadId: number }
type WorkerHeap = { entry: LiveWorker; heap: number }

export function installWorkerThreadDiagnostics(): void {
  const live = new Set<LiveWorker>()
  let largeSendLogSet = false
  let sampling: ReturnType<typeof setTimeout> | undefined
  const schedule = (delayMs: number): void => {
    sampling = setTimeout(() => {
      void sampleHeaps(live)
        .catch(() => 0)
        .then((total) =>
          schedule(total >= PRESSURED_BYTES ? PRESSURED_SAMPLE_INTERVAL_MS : SAMPLE_INTERVAL_MS)
        )
    }, delayMs)
    sampling.unref?.()
  }
  observeWorkerThreads({
    beforeSpawn: () => {
      if (!largeSendLogSet && resolveObservabilityConsent().localFileEnabled) {
        largeSendLogSet = true
        setWorkerLargeSendLog(join(getLogsDirectory(), 'worker-large-sends.ndjson'))
      }
    },
    spawned: (worker, role) => {
      const entry = { worker, role, threadId: worker.threadId }
      live.add(entry)
      worker.on('error', (error: Error & { code?: unknown }) => {
        const ledger = readWorkerSendLedger().find((slot) => slot.threadId === entry.threadId)
        recordDurableCrashBreadcrumb('worker_thread_failed', {
          role,
          code: typeof error?.code === 'string' ? error.code : null,
          ...(ledger ? ledgerData('', ledger) : {}),
          mainHeapMB: Math.round(getHeapStatistics().total_heap_size / MB)
        })
      })
      if (!sampling) {
        schedule(SAMPLE_INTERVAL_MS)
      }
    }
  })
}

/** Returns the committed heap of main plus every live worker. */
async function sampleHeaps(live: Set<LiveWorker>): Promise<number> {
  for (const entry of live) {
    if (entry.worker.threadId === -1) {
      live.delete(entry)
    }
  }
  const mainHeap = getHeapStatistics().total_heap_size
  const ledger = new Map(readWorkerSendLedger().map((slot) => [slot.threadId, slot]))
  const heaps: WorkerHeap[] = await Promise.all(
    [...live].map(async (entry) => ({
      entry,
      heap: await workerHeap(entry.worker).catch(
        () => (ledger.get(entry.threadId)?.heapUsedMB ?? 0) * MB
      )
    }))
  )
  heaps.sort((a, b) => b.heap - a.heap)
  const total = heaps.reduce((sum, { heap }) => sum + heap, mainHeap)
  annotateCrashReport(mainHeap, total, heaps, ledger)
  noteMainCageHeap(total, mainHeap)
  if (total >= BREADCRUMB_BYTES) {
    const data: CrashReportBreadcrumbData = {
      totalHeapMB: Math.round(total / MB),
      mainHeapMB: Math.round(mainHeap / MB),
      ...mainHeapSpaces(),
      workers: heaps.length
    }
    heaps.slice(0, REPORTED_WORKERS).forEach(({ entry, heap }, index) => {
      const slot = ledger.get(entry.threadId)
      Object.assign(data, {
        [`w${index}_role`]: entry.role,
        [`w${index}_heapMB`]: Math.round(heap / MB),
        ...(slot ? ledgerData(`w${index}_`, slot) : {})
      })
    })
    recordCoalescedDurableCrashBreadcrumb({
      name: 'worker_heap_pressure',
      data,
      coalesceKey: 'worker_heap_pressure',
      minIntervalMs: BREADCRUMB_MIN_INTERVAL_MS
    })
  }
  return total
}

/** A cage-wide OOM aborts before any JS runs, so the minidump carries the last sample. */
function annotateCrashReport(
  mainHeap: number,
  total: number,
  heaps: readonly WorkerHeap[],
  ledger: ReadonlyMap<number, WorkerSendLedgerEntry>
): void {
  const spaces = mainHeapSpaces()
  const annotations: [string, string][] = [
    [
      'orca-isolate-heap',
      `main=${Math.round(mainHeap / MB)}MB old=${spaces.mainOldMB}MB ` +
        `large=${spaces.mainLargeObjectMB}MB total=${Math.round(total / MB)}MB ` +
        `workers=${heaps.length} at=${new Date().toISOString()}`
    ]
  ]
  for (let index = 0; index < REPORTED_WORKERS; index += 1) {
    const sample = heaps[index]
    annotations.push([
      `orca-worker-${index}`,
      sample ? workerAnnotation(sample, ledger.get(sample.entry.threadId)) : ''
    ])
  }
  try {
    for (const [key, value] of annotations) {
      if (value) {
        crashReporter.addExtraParameter(key, value.slice(0, ANNOTATION_MAX_LENGTH))
      } else {
        crashReporter.removeExtraParameter(key)
      }
    }
  } catch {
    // Crash reporting may be off; diagnostics only.
  }
}

/** Large-object growth means retained big strings or arrays (payloads); old space, many objects. */
function mainHeapSpaces(): { mainOldMB: number; mainLargeObjectMB: number } {
  const spaces = getHeapSpaceStatistics()
  const used = (name: string): number =>
    Math.round((spaces.find((space) => space.space_name === name)?.space_used_size ?? 0) / MB)
  return { mainOldMB: used('old_space'), mainLargeObjectMB: used('large_object_space') }
}

function workerAnnotation(sample: WorkerHeap, slot: WorkerSendLedgerEntry | undefined): string {
  const heap = `${sample.entry.role} heap=${Math.round(sample.heap / MB)}MB`
  if (!slot) {
    return heap
  }
  const lastKB = Math.round(slot.lastBytes / 1024)
  const maxKB = Math.round(slot.maxBytes / 1024)
  return `${heap} last=${slot.lastKind}/${slot.lastItems}/${lastKB}KB max=${slot.maxKind}/${maxKB}KB`
}

function workerHeap(worker: Worker): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('worker heap read timed out')),
      WORKER_HEAP_READ_TIMEOUT_MS
    )
  })
  return Promise.race([
    Promise.resolve()
      .then(() => worker.getHeapStatistics())
      .then((stats) => stats.total_heap_size),
    timeout
  ]).finally(() => clearTimeout(timer))
}

function ledgerData(prefix: string, slot: WorkerSendLedgerEntry): CrashReportBreadcrumbData {
  return {
    [`${prefix}sends`]: slot.sends,
    [`${prefix}lastKind`]: slot.lastKind,
    [`${prefix}lastItems`]: slot.lastItems,
    [`${prefix}lastBytes`]: slot.lastBytes,
    [`${prefix}lastDepth`]: slot.lastDepth,
    [`${prefix}lastTruncated`]: slot.lastTruncated,
    [`${prefix}lastAgoMs`]: slot.lastAt > 0 ? Date.now() - slot.lastAt : null,
    [`${prefix}maxKind`]: slot.maxKind,
    [`${prefix}maxBytes`]: slot.maxBytes
  }
}
