import { getHeapStatistics } from 'node:v8'
import type { Worker } from 'node:worker_threads'
import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting/crash-reporting'
import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import { readWorkerSendLedger, type WorkerSendLedgerEntry } from './worker-send-ledger'
import type { WorkerThreadRole } from './worker-thread-roles'
import { observeWorkerThreads } from './worker-thread-spawn'

const SAMPLE_INTERVAL_MS = 60_000
/**
 * The main thread and every worker share one V8 pointer cage (~3.25 GB measured on Electron 43):
 * when it fills, whichever isolate allocates next aborts the whole app. Report the isolates that
 * hold it well before then, so the next failure names the one that grew.
 */
const HEAP_PRESSURE_BYTES = 1.5 * 2 ** 30
const REPORTED_WORKERS = 6
/** A worker blocked in native code (SQLite) answers only when it returns to JS. */
const WORKER_HEAP_READ_TIMEOUT_MS = 2_000
const MB = 2 ** 20

type LiveWorker = { worker: Worker; role: WorkerThreadRole; threadId: number }

export function installWorkerThreadDiagnostics(): void {
  const live = new Set<LiveWorker>()
  let sampling: ReturnType<typeof setInterval> | undefined
  let inFlight = false
  observeWorkerThreads((worker, role) => {
    const entry = { worker, role, threadId: worker.threadId }
    live.add(entry)
    worker.on('error', (error: Error & { code?: unknown }) => {
      const ledger = readWorkerSendLedger().find((slot) => slot.threadId === entry.threadId)
      recordDurableCrashBreadcrumb('worker_thread_failed', {
        role,
        code: typeof error?.code === 'string' ? error.code : null,
        ...(ledger ? ledgerData('', ledger) : {}),
        mainHeapMB: Math.round(getHeapStatistics().used_heap_size / MB)
      })
    })
    sampling ??= setInterval(() => {
      if (!inFlight) {
        inFlight = true
        void sampleHeapPressure(live).finally(() => (inFlight = false))
      }
    }, SAMPLE_INTERVAL_MS)
    sampling.unref?.()
  })
}

async function sampleHeapPressure(live: Set<LiveWorker>): Promise<void> {
  for (const entry of live) {
    if (entry.worker.threadId === -1) {
      live.delete(entry)
    }
  }
  const mainHeap = getHeapStatistics().used_heap_size
  const ledger = new Map(readWorkerSendLedger().map((slot) => [slot.threadId, slot]))
  const heaps = await Promise.all(
    [...live].map(async (entry) => ({
      entry,
      heap: await workerHeapUsed(entry.worker).catch(
        () => (ledger.get(entry.threadId)?.heapUsedMB ?? 0) * MB
      )
    }))
  )
  const total = heaps.reduce((sum, { heap }) => sum + heap, mainHeap)
  if (total < HEAP_PRESSURE_BYTES) {
    return
  }
  const data: CrashReportBreadcrumbData = {
    totalHeapMB: Math.round(total / MB),
    mainHeapMB: Math.round(mainHeap / MB),
    workers: heaps.length
  }
  heaps
    .sort((a, b) => b.heap - a.heap)
    .slice(0, REPORTED_WORKERS)
    .forEach(({ entry, heap }, index) => {
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
    minIntervalMs: SAMPLE_INTERVAL_MS
  })
}

function workerHeapUsed(worker: Worker): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('worker heap read timed out')), WORKER_HEAP_READ_TIMEOUT_MS)
  })
  return Promise.race([
    Promise.resolve()
      .then(() => worker.getHeapStatistics())
      .then((stats) => stats.used_heap_size),
    timeout
  ])
    .finally(() => clearTimeout(timer))
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
