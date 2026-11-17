import { getHeapStatistics } from 'node:v8'
import type { Worker } from 'node:worker_threads'
import { readWorkerSendLedger } from '../worker-threads/worker-send-ledger'
import {
  readWorkerHeap,
  WORKER_HEAP_BREADCRUMB_BYTES,
  WORKER_HEAP_PRESSURED_BYTES,
  WORKER_HEAP_PRESSURED_SAMPLE_INTERVAL_MS,
  WORKER_HEAP_SAMPLE_INTERVAL_MS
} from '../worker-threads/worker-heap-sample'
import type { UtilityWorkerHeapReport } from './utility-worker-host-protocol'

/** Smaller moves are noise for an OOM report and would only add IPC. */
const REPORT_CHANGE_BYTES = 64 * 2 ** 20
const MARKS = [WORKER_HEAP_PRESSURED_BYTES, WORKER_HEAP_BREADCRUMB_BYTES]

function total(report: UtilityWorkerHeapReport): number {
  return report.workers.reduce((sum, worker) => sum + (worker.bytes ?? 0), report.hostBytes)
}

/** Any isolate counts on its own, so one reader growing while another shrinks is still reported. */
export function utilityWorkerHeapReportChanged(
  last: UtilityWorkerHeapReport | undefined,
  next: UtilityWorkerHeapReport
): boolean {
  if (!last || last.workers.length !== next.workers.length) {
    return true
  }
  const moved = (a: number | null | undefined, b: number | null): boolean =>
    a === undefined ||
    (a === null) !== (b === null) ||
    Math.abs((a ?? 0) - (b ?? 0)) >= REPORT_CHANGE_BYTES
  const before = new Map(last.workers.map((worker) => [worker.id, worker.bytes]))
  return (
    moved(last.hostBytes, next.hostBytes) ||
    moved(total(last), total(next)) ||
    MARKS.some((mark) => total(last) >= mark !== total(next) >= mark) ||
    next.workers.some((worker) => moved(before.get(worker.id), worker.bytes))
  )
}

/**
 * Samples the host's heaps on the main process's cadence and posts only real changes, so a steady
 * host sends main nothing. The utility process can't annotate its own crash, so main keeps the last
 * report for the exit breadcrumb.
 */
export function sampleUtilityWorkerHeaps(
  workers: ReadonlyMap<number, Worker>,
  post: (report: UtilityWorkerHeapReport) => void
): { workersChanged(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let sampling = false
  let last: UtilityWorkerHeapReport | undefined
  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => void sample(), delayMs)
    timer.unref?.()
  }
  const sample = async (): Promise<void> => {
    timer = undefined
    sampling = true
    let delayMs = WORKER_HEAP_SAMPLE_INTERVAL_MS
    try {
      const ledger = new Map(readWorkerSendLedger().map((slot) => [slot.threadId, slot]))
      const readings = await Promise.all(
        [...workers].map(async ([id, worker]) => ({
          id,
          ...(await readWorkerHeap(worker, ledger.get(worker.threadId)))
        }))
      )
      // After the worker reads, which can take seconds, so the host's figure is current.
      const report = {
        sampledAt: Date.now(),
        hostBytes: getHeapStatistics().total_heap_size,
        workers: readings
      }
      if (total(report) >= WORKER_HEAP_PRESSURED_BYTES) {
        delayMs = WORKER_HEAP_PRESSURED_SAMPLE_INTERVAL_MS
      }
      if (utilityWorkerHeapReportChanged(last, report)) {
        last = report
        post(report)
      }
    } finally {
      sampling = false
      if (workers.size > 0 && !timer) {
        schedule(delayMs)
      }
    }
  }
  return {
    workersChanged: () => {
      if (workers.size === 0) {
        clearTimeout(timer)
        timer = undefined
      } else if (!timer && !sampling) {
        // The first report comes soon, so a host that dies young still says what it held.
        schedule(WORKER_HEAP_PRESSURED_SAMPLE_INTERVAL_MS)
      }
    }
  }
}
