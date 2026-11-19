import type { CrashReportBreadcrumbData } from '../../shared/crash-reporting/crash-reporting'
import { recordCoalescedDurableCrashBreadcrumb } from '../crash-reporting/breadcrumbs/durable-crash-breadcrumb'
import {
  WORKER_HEAP_BREADCRUMB_BYTES,
  WORKER_HEAP_BREADCRUMB_MIN_INTERVAL_MS
} from '../worker-threads/worker-heap-sample'
import type { HostedWorker } from './hosted-worker'
import {
  type UtilityWorkerHeapReport,
  utilityWorkerHeapTotal
} from './utility-worker-host-protocol'

const MB = 2 ** 20

/** Each worker's heap beside its replies; matched by spawn id, since every reader has one role. */
export function utilityWorkerHeapData(
  report: UtilityWorkerHeapReport | undefined,
  workers: readonly HostedWorker[]
): CrashReportBreadcrumbData {
  if (!report) {
    return { heapReportAgeS: null }
  }
  const heaps = new Map(report.workers.map((worker) => [worker.id, worker]))
  const data: CrashReportBreadcrumbData = {
    // Reports post only on change: later samples stayed within 64 MB of these figures.
    heapReportAgeS: Math.round((Date.now() - report.sampledAt) / 1000),
    hostHeapMB: Math.round(report.hostBytes / MB),
    totalHeapMB: Math.round(utilityWorkerHeapTotal(report) / MB),
    // The total covers the readers sampled then; some may have exited before this breadcrumb.
    heapReportWorkers: report.workers.length,
    // Unknown readings are left out of the total, so a nonzero count marks it as incomplete.
    heapReportUnknown: report.workers.filter((worker) => worker.bytes === null).length
  }
  workers.forEach((worker, index) => {
    const heap = heaps.get(worker.id)
    const bytes = heap?.bytes
    data[`w${index}_heapMB`] = typeof bytes === 'number' ? Math.round(bytes / MB) : null
    if (heap?.estimated) {
      data[`w${index}_heapEstimated`] = true
    }
  })
  return data
}

/** Its own coalescing key, so host and main pressure never suppress each other. */
export function recordUtilityWorkerHeapPressure(
  serviceName: string,
  report: UtilityWorkerHeapReport,
  workers: readonly HostedWorker[]
): void {
  if (utilityWorkerHeapTotal(report) < WORKER_HEAP_BREADCRUMB_BYTES) {
    return
  }
  const data = utilityWorkerHeapData(report, workers)
  workers.forEach((worker, index) => {
    data[`w${index}_lastReply`] = worker.lastReplyType
  })
  recordCoalescedDurableCrashBreadcrumb({
    name: 'worker_heap_pressure',
    data: { serviceName, workers: workers.length, ...data },
    coalesceKey: `worker_heap_pressure:${serviceName}`,
    minIntervalMs: WORKER_HEAP_BREADCRUMB_MIN_INTERVAL_MS
  })
}

/** One worker's own out-of-memory failure: its role, last reply and heap. */
export function utilityWorkerOutOfMemoryData(
  serviceName: string,
  worker: HostedWorker,
  report: UtilityWorkerHeapReport | undefined,
  code = 'ERR_WORKER_OUT_OF_MEMORY'
): CrashReportBreadcrumbData {
  return {
    serviceName,
    role: worker.spawn.name,
    code,
    lastReply: worker.lastReplyType,
    receivedMB: Math.round(worker.receivedBytes / MB),
    ...utilityWorkerHeapData(report, [worker])
  }
}

/** A host's exit: each worker's role, last reply and heap. */
export function utilityWorkerHostExitData(
  serviceName: string,
  code: number,
  workers: readonly HostedWorker[],
  report: UtilityWorkerHeapReport | undefined
): CrashReportBreadcrumbData {
  const data: CrashReportBreadcrumbData = {
    serviceName,
    code,
    workers: workers.length,
    ...utilityWorkerHeapData(report, workers)
  }
  workers.forEach((worker, index) => {
    data[`w${index}_role`] = worker.spawn.name
    data[`w${index}_lastReply`] = worker.lastReplyType
    data[`w${index}_receivedMB`] = Math.round(worker.receivedBytes / MB)
  })
  return data
}
