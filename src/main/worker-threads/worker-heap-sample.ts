import type { Worker } from 'node:worker_threads'
import type { WorkerSendLedgerEntry } from './worker-send-ledger'

/**
 * Heap sampling shared by every process that runs worker threads. Node only: a utility process
 * has no crash reporter, so callers own annotations and breadcrumbs.
 */
export const WORKER_HEAP_SAMPLE_INTERVAL_MS = 60_000
export const WORKER_HEAP_PRESSURED_SAMPLE_INTERVAL_MS = 10_000
export const WORKER_HEAP_PRESSURED_BYTES = 2 ** 30
export const WORKER_HEAP_BREADCRUMB_BYTES = 1.5 * 2 ** 30
export const WORKER_HEAP_BREADCRUMB_MIN_INTERVAL_MS = 10 * 60_000
/** A worker blocked in native code (SQLite) answers only when it returns to JS. */
const WORKER_HEAP_READ_TIMEOUT_MS = 2_000
const MB = 2 ** 20

/** Committed heap; when the worker can't answer, the used heap its last send recorded, if any. */
export type WorkerHeapReading = { bytes: number | null; estimated: boolean }

export async function readWorkerHeap(
  worker: Worker,
  ledger: WorkerSendLedgerEntry | undefined
): Promise<WorkerHeapReading> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('worker heap read timed out')),
      WORKER_HEAP_READ_TIMEOUT_MS
    )
  })
  try {
    const stats = await Promise.race([
      Promise.resolve().then(() => worker.getHeapStatistics()),
      timeout
    ])
    return { bytes: stats.total_heap_size, estimated: false }
  } catch {
    // The ledger's heap field stays 0 until the worker's first send writes it.
    const recorded = ledger && ledger.heapUsedMB > 0 ? ledger.heapUsedMB * MB : null
    return { bytes: recorded, estimated: true }
  } finally {
    clearTimeout(timer)
  }
}
